import { XMLParser } from "fast-xml-parser";
import { readFileSync } from "node:fs";
import type { Db } from "../db/index.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §3(b). Watchlist funds in config/funds.json (DECISIONS.md
// D5). Per fund: submissions JSON → two most recent 13F-HR filings → info-table
// XML from the filing's Archives folder. Each fund's CIK is verified against the
// entity name SEC returns — a mismatched CIK is skipped loudly, never ingested.
const SUBMISSIONS_BASE = "https://data.sec.gov/submissions";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";
const FUNDS_PATH = "config/funds.json";
const REQUEST_GAP_MS = 210;
const FILINGS_PER_FUND = 2; // latest + prior quarter for change detection

export interface FundConfig {
  name: string;
  cik: string;
  /** Substring that must appear in the SEC entity name for this CIK. */
  verify: string;
}

export function loadFunds(path: string = FUNDS_PATH): FundConfig[] {
  const parsed = JSON.parse(readFileSync(path, "utf8")) as { funds?: FundConfig[] };
  return (parsed.funds ?? []).filter((fund) => fund.name && fund.cik && fund.verify);
}

export interface HoldingRow {
  fund: string;
  cik: string;
  period: string;
  issuer: string;
  cusip: string;
  valueUsd: number | null;
  shares: number | null;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, removeNSPrefix: true });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse a 13F information-table XML into holdings, aggregating rows that share
 * a CUSIP (funds split positions across voting-authority buckets). Pure.
 */
export function mapInfoTable(
  xml: string,
  fund: { name: string; cik: string },
  period: string,
): HoldingRow[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const entries = asArray(doc.informationTable?.infoTable);
  const byCusip = new Map<string, HoldingRow>();
  for (const entry of entries as Record<string, any>[]) {
    const cusip = String(entry.cusip ?? "").trim().toUpperCase();
    const issuer = String(entry.nameOfIssuer ?? "").trim();
    if (!cusip || !issuer) continue;
    const value = num(entry.value);
    const shares = num(entry.shrsOrPrnAmt?.sshPrnamt);
    const existing = byCusip.get(cusip);
    if (existing) {
      existing.valueUsd = (existing.valueUsd ?? 0) + (value ?? 0);
      existing.shares = (existing.shares ?? 0) + (shares ?? 0);
    } else {
      byCusip.set(cusip, {
        fund: fund.name,
        cik: fund.cik,
        period,
        issuer,
        cusip,
        valueUsd: value,
        shares,
      });
    }
  }
  return normalizeValueUnits([...byCusip.values()]);
}

/**
 * Some filers still report `value` in thousands (pre-2023 convention) while
 * others use whole dollars — detectable per filing: a real book's median
 * implied share price is dollars-to-hundreds, a thousands-filed book implies
 * pennies. Scale the whole filing when the median implied price is absurd.
 */
export function normalizeValueUnits(rows: HoldingRow[]): HoldingRow[] {
  const impliedPrices = rows
    .filter((row) => row.valueUsd !== null && row.shares !== null && row.shares > 0)
    .map((row) => row.valueUsd! / row.shares!)
    .sort((a, b) => a - b);
  if (impliedPrices.length < 3) return rows;
  const median = impliedPrices[Math.floor(impliedPrices.length / 2)]!;
  if (median >= 2) return rows;
  return rows.map((row) =>
    row.valueUsd === null ? row : { ...row, valueUsd: row.valueUsd * 1000 },
  );
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function secJson(url: string, userAgent: string): Promise<unknown> {
  await sleep(REQUEST_GAP_MS);
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent, Accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.json();
}

async function secText(url: string, userAgent: string): Promise<string> {
  await sleep(REQUEST_GAP_MS);
  const response = await fetch(url, { headers: { "User-Agent": userAgent, Accept: "*/*" } });
  if (!response.ok) throw new Error(`${response.status} for ${url}`);
  return response.text();
}

interface SubmissionsRecent {
  form?: string[];
  accessionNumber?: string[];
  reportDate?: string[];
}

interface Filing13F {
  accession: string;
  period: string;
}

export function pickRecent13F(recent: SubmissionsRecent, limit: number): Filing13F[] {
  const filings: Filing13F[] = [];
  const forms = recent.form ?? [];
  for (let i = 0; i < forms.length && filings.length < limit; i++) {
    if (forms[i] === "13F-HR") {
      const accession = recent.accessionNumber?.[i];
      const period = recent.reportDate?.[i];
      if (accession && period) filings.push({ accession, period });
    }
  }
  return filings;
}

function holdingsExist(db: Db, cik: string, period: string): boolean {
  const row = db
    .prepare("SELECT 1 x FROM fund_holdings WHERE cik = ? AND period = ? LIMIT 1")
    .get(cik, period);
  return row !== undefined;
}

async function fetch13F(ctx: FetcherContext): Promise<FetchResult> {
  const { db, config } = ctx;
  const userAgent = config.SEC_USER_AGENT;
  if (!userAgent) throw new Error("SEC_USER_AGENT is required (see .env.example)");

  const insert = db.prepare(
    `INSERT OR IGNORE INTO fund_holdings (fund, cik, period, issuer, cusip, value_usd, shares)
     VALUES (@fund, @cik, @period, @issuer, @cusip, @valueUsd, @shares)`,
  );

  let inserted = 0;
  let skipped = 0;

  for (const fund of loadFunds()) {
    const padded = fund.cik.padStart(10, "0");
    let submissions: { name?: string; filings?: { recent?: SubmissionsRecent } };
    try {
      submissions = (await secJson(`${SUBMISSIONS_BASE}/CIK${padded}.json`, userAgent)) as typeof submissions;
    } catch (error) {
      console.error(`edgar-13f: ${fund.name}: submissions fetch failed — ${(error as Error).message}`);
      continue;
    }
    const entityName = (submissions.name ?? "").toUpperCase();
    if (!entityName.includes(fund.verify.toUpperCase())) {
      console.error(
        `edgar-13f: ${fund.name}: CIK ${fund.cik} resolves to "${submissions.name}" — ` +
          `expected to contain "${fund.verify}"; fix config/funds.json. Skipping.`,
      );
      continue;
    }

    for (const filing of pickRecent13F(submissions.filings?.recent ?? {}, FILINGS_PER_FUND)) {
      if (holdingsExist(db, fund.cik, filing.period)) continue;
      const folder = `${ARCHIVES_BASE}/${Number(fund.cik)}/${filing.accession.replaceAll("-", "")}`;
      try {
        const index = (await secJson(`${folder}/index.json`, userAgent)) as {
          directory?: { item?: { name: string }[] };
        };
        const xmlFile = (index.directory?.item ?? [])
          .map((item) => item.name)
          .find((name) => name.toLowerCase().endsWith(".xml") && !name.toLowerCase().includes("primary_doc"));
        if (!xmlFile) {
          console.error(`edgar-13f: ${fund.name} ${filing.period}: no info-table XML found`);
          continue;
        }
        const rows = mapInfoTable(
          await secText(`${folder}/${xmlFile}`, userAgent),
          fund,
          filing.period,
        );
        const insertAll = db.transaction((holdingRows: HoldingRow[]) => {
          for (const row of holdingRows) {
            if (insert.run(row).changes > 0) inserted++;
            else skipped++;
          }
        });
        insertAll(rows);
      } catch (error) {
        console.error(`edgar-13f: ${fund.name} ${filing.period}: ${(error as Error).message}`);
      }
    }
  }

  return { inserted, skipped };
}

export const edgar13fFetcher: Fetcher = {
  name: "edgar-13f",
  fetch: fetch13F,
};
