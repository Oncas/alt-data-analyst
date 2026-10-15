import { getWatermark, setWatermark } from "../db/index.js";
import { normalizeCompanyName } from "../util/companies.js";
import { shiftDate, todayIso } from "../util/dates.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// SEC's official public-company list (~10k rows). Refreshed weekly — listings
// don't churn faster than that. Needs the declared SEC User-Agent like all
// sec.gov hosts (docs/SOURCES.md §3).
const TICKERS_URL = "https://www.sec.gov/files/company_tickers.json";
const REFRESH_DAYS = 7;

interface SecTickerEntry {
  cik_str?: number;
  ticker?: string;
  title?: string;
}

async function fetchTickers(ctx: FetcherContext): Promise<FetchResult> {
  const { db, config } = ctx;
  if (!config.SEC_USER_AGENT) {
    throw new Error("SEC_USER_AGENT is required (see .env.example)");
  }
  const lastRefresh = getWatermark(db, "tickers");
  if (lastRefresh && lastRefresh > shiftDate(todayIso(), -REFRESH_DAYS)) {
    return { inserted: 0, skipped: 0 };
  }

  const response = await fetch(TICKERS_URL, {
    headers: { "User-Agent": config.SEC_USER_AGENT, Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`company_tickers ${response.status}`);
  }
  const data = (await response.json()) as Record<string, SecTickerEntry>;

  // SEC orders entries by market cap-ish index; first entry wins on name
  // collisions (e.g. Alphabet's GOOGL before GOOG), which is what we want.
  const insert = db.prepare(
    `INSERT OR IGNORE INTO company_tickers (normalized_name, ticker, cik, title)
     VALUES (?, ?, ?, ?)`,
  );
  let inserted = 0;
  let skipped = 0;
  const insertAll = db.transaction((entries: SecTickerEntry[]) => {
    for (const entry of entries) {
      if (!entry.ticker || !entry.title) {
        skipped++;
        continue;
      }
      const normalized = normalizeCompanyName(entry.title);
      if (!normalized) {
        skipped++;
        continue;
      }
      const result = insert.run(
        normalized,
        entry.ticker.toUpperCase(),
        entry.cik_str !== undefined ? String(entry.cik_str) : null,
        entry.title,
      );
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });
  insertAll(Object.values(data));

  setWatermark(db, "tickers", todayIso());
  return { inserted, skipped };
}

export const tickersFetcher: Fetcher = {
  name: "tickers",
  fetch: fetchTickers,
};
