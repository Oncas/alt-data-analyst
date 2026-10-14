import { XMLParser } from "fast-xml-parser";
import { getWatermark, setWatermark } from "../db/index.js";
import { shiftDate, todayIso } from "../util/dates.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §3(a). EFTS full-text search finds recent Form 4s across
// all companies; each filing's ownership XML is then fetched for the actual
// transactions. SEC policy: declared User-Agent required, max 10 req/s (we run
// well under at ~5/s).
const EFTS_URL = "https://efts.sec.gov/LATEST/search-index";
const ARCHIVES_BASE = "https://www.sec.gov/Archives/edgar/data";

const PAGE_SIZE = 100;
const DEFAULT_BACKFILL_DAYS = 5;
/** XML fetch budget per run; the day-granular watermark resumes the remainder. */
const MAX_FILINGS_PER_RUN = 400;
const REQUEST_GAP_MS = 210;

/** Only open-market buys (P) and sales (S) — grants/exercises are noise for us. */
const KEPT_CODES = new Set(["P", "S"]);

export interface InsiderTradeRow {
  accession: string;
  txnIndex: number;
  ticker: string | null;
  issuerName: string | null;
  issuerCik: string | null;
  insiderName: string | null;
  insiderRole: string | null;
  transactionCode: string;
  transactionDate: string | null;
  shares: number | null;
  price: number | null;
  value: number | null;
  acquiredDisposed: string | null;
  filedAt: string | null;
}

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false });

function asArray<T>(value: T | T[] | undefined): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function num(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** XML leaf values arrive as `{ value: "123" }` or plain scalars. */
function leaf(node: unknown): unknown {
  if (node && typeof node === "object" && "value" in (node as Record<string, unknown>)) {
    return (node as Record<string, unknown>).value;
  }
  return node;
}

function describeRole(relationship: Record<string, unknown> | undefined): string | null {
  if (!relationship) return null;
  const roles: string[] = [];
  const officerTitle = String(leaf(relationship.officerTitle) ?? "").trim();
  if (officerTitle) roles.push(officerTitle);
  else if (String(leaf(relationship.isOfficer)) === "1") roles.push("Officer");
  if (String(leaf(relationship.isDirector)) === "1") roles.push("Director");
  if (String(leaf(relationship.isTenPercentOwner)) === "1") roles.push("10% owner");
  return roles.length > 0 ? roles.join(", ") : null;
}

/** Parse one Form 4 ownership XML into P/S transaction rows. Pure; fixture-tested. */
export function mapForm4(xml: string, accession: string, filedAt: string | null): InsiderTradeRow[] {
  let doc: Record<string, any>;
  try {
    doc = parser.parse(xml);
  } catch {
    return [];
  }
  const ownership = doc.ownershipDocument;
  if (!ownership) return [];

  const issuer = ownership.issuer ?? {};
  const owners = asArray(ownership.reportingOwner);
  const firstOwner = owners[0] ?? {};
  const insiderName =
    String(leaf(firstOwner.reportingOwnerId?.rptOwnerName) ?? "").trim() || null;
  const insiderRole = describeRole(firstOwner.reportingOwnerRelationship);

  // Non-listed issuers file placeholder symbols — treat them as no ticker.
  const tickerRaw = String(leaf(issuer.issuerTradingSymbol) ?? "").trim().toUpperCase();
  const ticker = tickerRaw && !["NONE", "N/A", "NA"].includes(tickerRaw) ? tickerRaw : null;

  const transactions = asArray(ownership.nonDerivativeTable?.nonDerivativeTransaction);
  const rows: InsiderTradeRow[] = [];
  transactions.forEach((txn: Record<string, any>, index: number) => {
    const code = String(leaf(txn.transactionCoding?.transactionCode) ?? "");
    if (!KEPT_CODES.has(code)) return;
    const shares = num(leaf(txn.transactionAmounts?.transactionShares));
    const price = num(leaf(txn.transactionAmounts?.transactionPricePerShare));
    rows.push({
      accession,
      txnIndex: index,
      ticker,
      issuerName: String(leaf(issuer.issuerName) ?? "").trim() || null,
      issuerCik: String(leaf(issuer.issuerCik) ?? "").trim() || null,
      insiderName,
      insiderRole,
      transactionCode: code,
      transactionDate: String(leaf(txn.transactionDate) ?? "").trim() || null,
      shares,
      price,
      value: shares !== null && price !== null ? shares * price : null,
      acquiredDisposed:
        String(leaf(txn.transactionAmounts?.transactionAcquiredDisposedCode) ?? "").trim() || null,
      filedAt,
    });
  });
  return rows;
}

export interface EftsHit {
  _id: string; // "0001234567-26-000123:form4.xml"
  _source: { ciks?: string[]; file_date?: string };
}

export function archiveUrlFor(hit: EftsHit): string | null {
  const [accession, filename] = hit._id.split(":");
  const cik = hit._source.ciks?.[0];
  if (!accession || !filename || !cik) return null;
  const cikTrimmed = String(Number(cik));
  return `${ARCHIVES_BASE}/${cikTrimmed}/${accession.replaceAll("-", "")}/${filename}`;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function secHeaders(userAgent: string): Record<string, string> {
  return { "User-Agent": userAgent, Accept: "*/*" };
}

async function throttledFetch(url: string, userAgent: string): Promise<Response> {
  await sleep(REQUEST_GAP_MS);
  return fetch(url, { headers: secHeaders(userAgent) });
}

interface EftsResponse {
  hits?: { hits?: EftsHit[] };
}

async function eftsPage(
  day: string,
  from: number,
  userAgent: string,
): Promise<EftsHit[]> {
  const url = new URL(EFTS_URL);
  url.searchParams.set("forms", "4");
  url.searchParams.set("dateRange", "custom");
  url.searchParams.set("startdt", day);
  url.searchParams.set("enddt", day);
  url.searchParams.set("from", String(from));
  url.searchParams.set("size", String(PAGE_SIZE));
  const response = await throttledFetch(url.toString(), userAgent);
  if (!response.ok) {
    throw new Error(`EFTS ${response.status}: ${(await response.text()).slice(0, 200)}`);
  }
  const data = (await response.json()) as EftsResponse;
  return data.hits?.hits ?? [];
}

async function fetchForm4s(ctx: FetcherContext): Promise<FetchResult> {
  const { db, config } = ctx;
  const userAgent = config.SEC_USER_AGENT;
  if (!userAgent) {
    throw new Error(
      "SEC_USER_AGENT is required (SEC policy: 'Name email' identifying you; see .env.example)",
    );
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO insider_trades
       (accession, txn_index, ticker, issuer_name, issuer_cik, insider_name,
        insider_role, transaction_code, transaction_date, shares, price, value,
        acquired_disposed, filed_at)
     VALUES (@accession, @txnIndex, @ticker, @issuerName, @issuerCik, @insiderName,
             @insiderRole, @transactionCode, @transactionDate, @shares, @price, @value,
             @acquiredDisposed, @filedAt)`,
  );

  const today = todayIso();
  let day = getWatermark(db, "edgar-form4") ?? shiftDate(today, -DEFAULT_BACKFILL_DAYS);
  let inserted = 0;
  let skipped = 0;
  let filingsProcessed = 0;

  while (day <= today && filingsProcessed < MAX_FILINGS_PER_RUN) {
    let from = 0;
    let dayComplete = false;
    while (!dayComplete && filingsProcessed < MAX_FILINGS_PER_RUN) {
      const hits = await eftsPage(day, from, userAgent);
      for (const hit of hits) {
        if (filingsProcessed >= MAX_FILINGS_PER_RUN) break;
        const url = archiveUrlFor(hit);
        if (!url) continue;
        filingsProcessed++;
        const response = await throttledFetch(url, userAgent);
        if (!response.ok) {
          skipped++;
          continue;
        }
        const [accession] = hit._id.split(":");
        const rows = mapForm4(await response.text(), accession!, hit._source.file_date ?? null);
        const insertAll = db.transaction((tradeRows: InsiderTradeRow[]) => {
          for (const row of tradeRows) {
            if (insert.run(row).changes > 0) inserted++;
            else skipped++;
          }
        });
        insertAll(rows);
      }
      if (hits.length < PAGE_SIZE) dayComplete = true;
      else from += PAGE_SIZE;
    }
    if (!dayComplete) break; // budget exhausted mid-day; resume this day next run
    // Day fully processed: safe to advance. Dedupe absorbs boundary re-reads.
    setWatermark(db, "edgar-form4", day);
    day = shiftDate(day, 1);
  }

  return { inserted, skipped };
}

export const edgarForm4Fetcher: Fetcher = {
  name: "edgar-form4",
  fetch: fetchForm4s,
};
