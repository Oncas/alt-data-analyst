import { getWatermark, insertSignal, setWatermark, type Db } from "../db/index.js";
import { registerEvidenceFormatter } from "../report/digest.js";
import { shiftDate, todayIso } from "../util/dates.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §4. Primary: kadoa's daily-refreshed aggregate of House,
// Senate, and OGE disclosures (research/educational use — personal research here).
// trades.json is a rolling window of the ~5k most recent records; full history
// (DECISIONS.md D3: full backfill) lives in per-filer files under data/filer/,
// walked once and recorded in fetch_state under "congress-backfill".
// Fallback if this dataset dies: House Clerk {YEAR}FD.zip index + PTR PDFs at
// disclosures-clerk.house.gov (House-only, needs PDF parsing) — see SOURCES.md.
const DATA_BASE =
  "https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data";
const DATASET_URL = `${DATA_BASE}/trades.json`;
const FILERS_URL = `${DATA_BASE}/filers.json`;
const BACKFILL_REQUEST_GAP_MS = 80;

/** If the newest filing in the dataset is older than this, raise a digest alert. */
export const STALE_AFTER_DAYS = 7;

const TICKER_PLACEHOLDERS = new Set(["", "--", "-", "N/A", "NA", "NONE", "NULL"]);

registerEvidenceFormatter("meta.source-stale", (e) =>
  `${e.source}: newest record is from ${e.newestDate} (threshold ${e.thresholdDays}d) — ` +
  `check the upstream dataset; fallback documented in docs/SOURCES.md`,
);

export interface KadoaTradeRaw {
  id?: string | number;
  transaction_date?: string;
  filing_date?: string;
  owner?: string;
  ticker?: string | null;
  asset_name?: string;
  asset_type?: string;
  transaction_type?: string;
  amount_range_low?: number | null;
  amount_range_high?: number | null;
  amount_range_label?: string;
  days_to_file?: number;
  is_late?: boolean;
  filer_name?: string;
  chamber?: string;
  party?: string;
  state?: string;
  office?: string;
  doc_url?: string;
  filing_type?: string;
}

export interface CongressTradeRow {
  sourceId: string;
  filerName: string;
  chamber: string | null;
  party: string | null;
  state: string | null;
  office: string | null;
  owner: string | null;
  ticker: string | null;
  assetName: string | null;
  assetType: string | null;
  transactionType: string | null;
  transactionDate: string | null;
  filingDate: string | null;
  amountLow: number | null;
  amountHigh: number | null;
  amountLabel: string | null;
  daysToFile: number | null;
  isLate: number;
  docUrl: string | null;
}

export function normalizeTicker(ticker: string | null | undefined): string | null {
  if (ticker === null || ticker === undefined) return null;
  const upper = ticker.trim().toUpperCase();
  return TICKER_PLACEHOLDERS.has(upper) ? null : upper;
}

export interface FilerDefaults {
  filer_name?: string;
  chamber?: string | null;
  party?: string | null;
  state?: string | null;
  office?: string | null;
}

/** Per-filer files carry filer identity once at file level — pass it as defaults. */
export function mapTrade(raw: KadoaTradeRaw, filer: FilerDefaults = {}): CongressTradeRow | null {
  const filerName = raw.filer_name ?? filer.filer_name;
  if (raw.id === undefined || raw.id === null || !filerName) return null;
  return {
    sourceId: String(raw.id),
    filerName,
    chamber: raw.chamber ?? filer.chamber ?? null,
    party: raw.party ?? filer.party ?? null,
    state: raw.state ?? filer.state ?? null,
    office: raw.office ?? filer.office ?? null,
    owner: raw.owner ?? null,
    ticker: normalizeTicker(raw.ticker),
    assetName: raw.asset_name ?? null,
    assetType: raw.asset_type ?? null,
    transactionType: raw.transaction_type?.toLowerCase() ?? null,
    transactionDate: raw.transaction_date ?? null,
    filingDate: raw.filing_date ?? null,
    amountLow: raw.amount_range_low ?? null,
    amountHigh: raw.amount_range_high ?? null,
    amountLabel: raw.amount_range_label ?? null,
    daysToFile: raw.days_to_file ?? null,
    isLate: raw.is_late ? 1 : 0,
    docUrl: raw.doc_url ?? null,
  };
}

export function isStale(newestFilingDate: string | null, today: string): boolean {
  if (!newestFilingDate) return true;
  return newestFilingDate < shiftDate(today, -STALE_AFTER_DAYS);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url: string): Promise<unknown> {
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  if (!response.ok) {
    throw new Error(`congress dataset ${response.status} for ${url}`);
  }
  return response.json();
}

interface FilerListEntry extends FilerDefaults {
  id?: string;
  full_name?: string;
  trade_count?: number;
}

interface InsertCounters {
  inserted: number;
  skipped: number;
}

/** One-time walk of per-filer history files (D3: full backfill). */
async function backfillFromFilerFiles(
  db: Db,
  insertRows: (rows: KadoaTradeRaw[], filer: FilerDefaults) => void,
): Promise<void> {
  const filers = (await getJson(FILERS_URL)) as FilerListEntry[];
  if (!Array.isArray(filers)) throw new Error("congress filers.json: unexpected shape");
  const withTrades = filers.filter((filer) => filer.id && (filer.trade_count ?? 0) > 0);
  console.error(`congress: backfilling full history from ${withTrades.length} filer file(s)`);

  for (const [index, filer] of withTrades.entries()) {
    const data = (await getJson(`${DATA_BASE}/filer/${filer.id}.json`)) as {
      trades?: KadoaTradeRaw[];
    };
    insertRows(asTradeArray(data.trades), {
      filer_name: filer.full_name,
      chamber: filer.chamber,
      party: filer.party,
      state: filer.state,
      office: filer.office,
    });
    if ((index + 1) % 100 === 0) {
      console.error(`congress: backfill ${index + 1}/${withTrades.length} filers`);
    }
    await sleep(BACKFILL_REQUEST_GAP_MS);
  }
}

function asTradeArray(value: unknown): KadoaTradeRaw[] {
  return Array.isArray(value) ? (value as KadoaTradeRaw[]) : [];
}

async function fetchCongress(ctx: FetcherContext): Promise<FetchResult> {
  const { db } = ctx;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO congress_trades
       (source_id, filer_name, chamber, party, state, office, owner, ticker,
        asset_name, asset_type, transaction_type, transaction_date, filing_date,
        amount_low, amount_high, amount_label, days_to_file, is_late, doc_url)
     VALUES (@sourceId, @filerName, @chamber, @party, @state, @office, @owner, @ticker,
             @assetName, @assetType, @transactionType, @transactionDate, @filingDate,
             @amountLow, @amountHigh, @amountLabel, @daysToFile, @isLate, @docUrl)`,
  );

  const counters: InsertCounters = { inserted: 0, skipped: 0 };
  let newestFilingDate: string | null = null;

  const insertRows = db.transaction((rows: KadoaTradeRaw[], filer: FilerDefaults = {}) => {
    for (const rawRow of rows) {
      const row = mapTrade(rawRow, filer);
      if (!row) {
        counters.skipped++;
        continue;
      }
      if (row.filingDate && (!newestFilingDate || row.filingDate > newestFilingDate)) {
        newestFilingDate = row.filingDate;
      }
      if (insert.run(row).changes > 0) counters.inserted++;
      else counters.skipped++;
    }
  });

  if (!getWatermark(db, "congress-backfill")) {
    await backfillFromFilerFiles(db, (rows, filer) => insertRows(rows, filer));
    setWatermark(db, "congress-backfill", todayIso());
  }

  const raw = (await getJson(DATASET_URL)) as KadoaTradeRaw[];
  if (!Array.isArray(raw)) {
    throw new Error("congress dataset: unexpected shape (not an array)");
  }
  insertRows(raw);

  const today = todayIso();
  if (isStale(newestFilingDate, today)) {
    // Surface in the digest rather than only in a log nobody reads.
    insertSignal(db, {
      source: "congress",
      rule: "meta.source-stale",
      dedupeKey: `congress|${newestFilingDate ?? "empty"}`,
      severity: 2,
      evidence: {
        source: "congress (kadoa dataset)",
        newestDate: newestFilingDate,
        thresholdDays: STALE_AFTER_DAYS,
      },
    });
    console.error(`congress: dataset stale (newest filing ${newestFilingDate})`);
  }
  if (newestFilingDate) setWatermark(db, "congress", newestFilingDate);

  return counters;
}

export const congressFetcher: Fetcher = {
  name: "congress",
  fetch: fetchCongress,
};
