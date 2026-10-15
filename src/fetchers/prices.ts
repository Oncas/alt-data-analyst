import { getWatermark, setWatermark, type Db } from "../db/index.js";
import { todayIso } from "../util/dates.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §5. Yahoo Finance's chart JSON: unauthenticated daily OHLC.
// Stooq's CSV endpoint (the obvious alternative) sits behind a JavaScript
// proof-of-work bot wall as of 2026-07-22 and is unusable from a plain client.
//
// A browser-ish User-Agent is REQUIRED: bare clients get "Edge: Too Many
// Requests" (429) from Yahoo's CDN regardless of volume.
const CHART_BASE = "https://query1.finance.yahoo.com/v8/finance/chart";
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const REQUEST_GAP_MS = 250;
/** First sight of a ticker: pull a year of history. */
const BACKFILL_RANGE = "1y";
/** Ticker already stored: a month covers any gap plus late corrections. */
const INCREMENTAL_RANGE = "1mo";
/**
 * Ceiling on tickers per run so a bloated signals table can't turn the daily
 * fetch into an hour-long crawl. Signals are prioritised over trade tables, and
 * overflow rotates (see selectTickers) rather than starving.
 */
const MAX_TICKERS = 400;
/**
 * Only chase congress/insider tickers still recent enough to be interesting.
 * Measured 2026-07-22: 90d ≈ 453 candidate tickers, 180d ≈ 805 — the longer
 * window doubles runtime for names nobody is going to write about.
 */
const TRADE_LOOKBACK_DAYS = 90;

const TICKER_PLACEHOLDERS = new Set(["", "--", "-", "N/A", "NA", "NONE", "NULL"]);

export interface PriceRow {
  ticker: string;
  date: string;
  open: number | null;
  high: number | null;
  low: number | null;
  close: number;
  volume: number | null;
}

interface ChartMeta {
  gmtoffset?: number;
  regularMarketTime?: number;
  currentTradingPeriod?: { regular?: { start?: number; end?: number } };
}

interface ChartQuote {
  open?: (number | null)[];
  high?: (number | null)[];
  low?: (number | null)[];
  close?: (number | null)[];
  volume?: (number | null)[];
}

export interface ChartResponse {
  chart?: {
    result?:
      | {
          meta?: ChartMeta;
          timestamp?: number[];
          indicators?: { quote?: ChartQuote[] };
        }[]
      | null;
    error?: { code?: string; description?: string } | null;
  };
}

/**
 * Yahoo spells share classes with a dash (BRK-B), which is also how SEC's
 * company_tickers.json spells them — but congressional filings sometimes use a
 * dot, so fold that in.
 */
export function normalizeYahooTicker(ticker: string | null | undefined): string | null {
  if (ticker === null || ticker === undefined) return null;
  const upper = ticker.trim().toUpperCase();
  if (TICKER_PLACEHOLDERS.has(upper)) return null;
  // Reject anything that isn't a plausible symbol rather than URL-injecting it.
  if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(upper)) return null;
  return upper.replace(/\./g, "-");
}

/** Bar timestamps are exchange-open instants; render the date in exchange time. */
export function epochToExchangeDate(epochSeconds: number, gmtOffsetSeconds: number): string {
  return new Date((epochSeconds + gmtOffsetSeconds) * 1000).toISOString().slice(0, 10);
}

/**
 * The final bar of an intraday response is the CURRENT session: its "close" is
 * the live price and it moves tick to tick. Storing it would freeze a mid-session
 * quote as that day's close forever, because re-runs dedupe with INSERT OR IGNORE
 * and never overwrite. So drop it and let tomorrow's run collect the settled close.
 */
export function isBarInProgress(meta: ChartMeta, barEpoch: number): boolean {
  const { regularMarketTime, currentTradingPeriod } = meta;
  if (regularMarketTime === undefined) return false;
  const gmtOffset = meta.gmtoffset ?? 0;
  const sessionEnd = currentTradingPeriod?.regular?.end;
  // Market already closed for the day -> the bar has settled.
  if (sessionEnd !== undefined && regularMarketTime >= sessionEnd) return false;
  return (
    epochToExchangeDate(barEpoch, gmtOffset) ===
    epochToExchangeDate(regularMarketTime, gmtOffset)
  );
}

/**
 * Chart JSON -> settled daily bars. Rows without a close (halts, padding) are
 * dropped rather than carried forward: a fabricated price is worse than a gap.
 */
export function parseChart(ticker: string, payload: ChartResponse): PriceRow[] {
  const result = payload.chart?.result?.[0];
  if (!result) {
    const description = payload.chart?.error?.description ?? "no result";
    throw new Error(`chart payload for ${ticker}: ${description}`);
  }
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const meta = result.meta ?? {};
  const gmtOffset = meta.gmtoffset ?? 0;

  const rows: PriceRow[] = [];
  for (const [index, epoch] of timestamps.entries()) {
    const close = quote.close?.[index];
    if (close === null || close === undefined || !Number.isFinite(close)) continue;
    if (isBarInProgress(meta, epoch)) continue;
    const volume = quote.volume?.[index];
    rows.push({
      ticker,
      date: epochToExchangeDate(epoch, gmtOffset),
      open: finiteOrNull(quote.open?.[index]),
      high: finiteOrNull(quote.high?.[index]),
      low: finiteOrNull(quote.low?.[index]),
      close,
      volume: finiteOrNull(volume),
    });
  }
  return rows;
}

function finiteOrNull(value: number | null | undefined): number | null {
  return value !== null && value !== undefined && Number.isFinite(value) ? value : null;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchChart(ticker: string, range: string): Promise<ChartResponse> {
  const url = `${CHART_BASE}/${encodeURIComponent(ticker)}?range=${range}&interval=1d`;
  const response = await fetch(url, {
    headers: { "User-Agent": BROWSER_UA, Accept: "application/json" },
  });
  if (!response.ok) {
    // 404 = unknown/delisted symbol, 429 = throttled. Both are per-ticker
    // problems; the caller downgrades them to a skip.
    throw new Error(`yahoo chart ${response.status} for ${ticker}`);
  }
  return (await response.json()) as ChartResponse;
}

/**
 * Tickers worth pricing: everything we've ever emitted a signal for, plus
 * recently traded names from congress/insider feeds. Deliberately NOT the whole
 * company_tickers list (~8k rows) — that would be an 8k-request crawl.
 *
 * Ordering matters because of the cap. Signal tickers come first (rank 0) so the
 * names we actually write about are never dropped. Within a rank, tickers we've
 * never priced come first, then the stalest — so when the candidate set exceeds
 * the cap the overflow rotates in on subsequent runs instead of the alphabetical
 * tail starving forever.
 */
export function selectTickers(db: Db, opts: { tradeSince: string; limit: number }): string[] {
  const rows = db
    .prepare(
      `SELECT t.ticker AS ticker, MIN(t.rank) AS rank,
              (SELECT MAX(p.date) FROM prices p
                WHERE p.ticker = REPLACE(UPPER(t.ticker), '.', '-')) AS lastPriced
       FROM (
         SELECT ticker, 0 AS rank FROM signals WHERE ticker IS NOT NULL
         UNION ALL
         SELECT ticker, 1 AS rank FROM congress_trades
           WHERE ticker IS NOT NULL AND transaction_date >= @tradeSince
         UNION ALL
         SELECT ticker, 1 AS rank FROM insider_trades
           WHERE ticker IS NOT NULL AND transaction_date >= @tradeSince
       ) t
       GROUP BY t.ticker
       ORDER BY rank, lastPriced IS NOT NULL, lastPriced, t.ticker
       LIMIT @limit`,
    )
    .all({ tradeSince: opts.tradeSince, limit: opts.limit }) as { ticker: string }[];

  const seen = new Set<string>();
  for (const row of rows) {
    const normalized = normalizeYahooTicker(row.ticker);
    if (normalized) seen.add(normalized);
  }
  return [...seen];
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

async function fetchPrices(ctx: FetcherContext): Promise<FetchResult> {
  const { db } = ctx;
  const today = todayIso();
  // Daily cadence: a second run on the same day would only re-read bars we have.
  if (getWatermark(db, "prices") === today) {
    return { inserted: 0, skipped: 0 };
  }

  const tickers = selectTickers(db, {
    tradeSince: isoDaysAgo(TRADE_LOOKBACK_DAYS),
    limit: MAX_TICKERS,
  });
  if (tickers.length === 0) {
    setWatermark(db, "prices", today);
    return { inserted: 0, skipped: 0 };
  }

  const insert = db.prepare(
    `INSERT OR IGNORE INTO prices (ticker, date, open, high, low, close, volume)
     VALUES (@ticker, @date, @open, @high, @low, @close, @volume)`,
  );
  const hasHistory = db.prepare("SELECT 1 FROM prices WHERE ticker = ? LIMIT 1");

  let inserted = 0;
  let skipped = 0;
  let failedTickers = 0;

  const insertAll = db.transaction((rows: PriceRow[]) => {
    for (const row of rows) {
      if (insert.run(row).changes > 0) inserted++;
      else skipped++;
    }
  });

  for (const [index, ticker] of tickers.entries()) {
    if (index > 0) await sleep(REQUEST_GAP_MS);
    // Per-ticker range: backfill a year on first sight, then stay incremental.
    const range = hasHistory.get(ticker) ? INCREMENTAL_RANGE : BACKFILL_RANGE;
    try {
      insertAll(parseChart(ticker, await fetchChart(ticker, range)));
    } catch (error) {
      // One dead symbol must not cost us the other 399.
      failedTickers++;
      skipped++;
      console.error(`prices: skipping ${ticker} — ${(error as Error).message}`);
    }
  }

  if (failedTickers === tickers.length) {
    // Every symbol failing is an endpoint problem (UA blocked, CDN throttle),
    // not bad data. Fail loudly and leave the watermark alone so we retry.
    throw new Error(`prices: all ${tickers.length} ticker(s) failed — check the chart endpoint`);
  }

  setWatermark(db, "prices", today);
  return { inserted, skipped };
}

export const pricesFetcher: Fetcher = {
  name: "prices",
  fetch: fetchPrices,
};
