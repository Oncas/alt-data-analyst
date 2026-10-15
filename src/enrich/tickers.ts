import { readFileSync } from "node:fs";
import type { Db } from "../db/index.js";
import { normalizeCompanyName } from "../util/companies.js";

// Manual overrides for names the SEC list can't resolve — mostly subsidiaries
// whose parent trades publicly (DECISIONS.md D6: conservative matching; grow
// this file instead of loosening the matcher). Value null = "known non-match,
// stop suggesting it".
const OVERRIDES_PATH = "config/ticker-overrides.json";

export type OverrideMap = Record<string, string | null>;

export function loadOverrides(path: string = OVERRIDES_PATH): OverrideMap {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>)
          .filter(([, value]) => typeof value === "string" || value === null)
          .map(([key, value]) => [normalizeCompanyName(key), value as string | null]),
      );
    }
  } catch {
    // Missing or malformed overrides file: fall through to SEC-list-only.
  }
  return {};
}

/** Overrides first, then the SEC company list on normalized name. */
export function lookupTicker(
  db: Db,
  companyName: string,
  overrides: OverrideMap,
): string | null {
  const normalized = normalizeCompanyName(companyName);
  if (!normalized) return null;
  if (normalized in overrides) return overrides[normalized] ?? null;
  const row = db
    .prepare("SELECT ticker FROM company_tickers WHERE normalized_name = ?")
    .get(normalized) as { ticker: string } | undefined;
  return row?.ticker ?? null;
}

/** Fill tickers on signals that only carry a company name. Returns count filled. */
export function enrichSignalTickers(db: Db, overrides: OverrideMap = loadOverrides()): number {
  const pending = db
    .prepare(
      "SELECT id, company FROM signals WHERE ticker IS NULL AND company IS NOT NULL",
    )
    .all() as { id: number; company: string }[];
  const update = db.prepare("UPDATE signals SET ticker = ? WHERE id = ?");
  let filled = 0;
  const run = db.transaction((rows: { id: number; company: string }[]) => {
    for (const row of rows) {
      const ticker = lookupTicker(db, row.company, overrides);
      if (ticker) {
        update.run(ticker, row.id);
        filled++;
      }
    }
  });
  run(pending);
  return filled;
}
