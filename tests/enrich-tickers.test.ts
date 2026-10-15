import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { insertSignal, migrate, type Db } from "../src/db/index.js";
import {
  enrichSignalTickers,
  lookupTicker,
  type OverrideMap,
} from "../src/enrich/tickers.js";

function dbWithTickers(): Db {
  const db = new Database(":memory:") as Db;
  migrate(db);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO company_tickers (normalized_name, ticker, cik, title) VALUES (?, ?, ?, ?)",
  );
  insert.run("MOTOROLA SOLUTIONS", "MSI", "68505", "Motorola Solutions, Inc.");
  insert.run("ALPHABET", "GOOGL", "1652044", "Alphabet Inc.");
  return db;
}

describe("lookupTicker", () => {
  const overrides: OverrideMap = {
    "AMERICAN CENTRIFUGE OPERATING": "LEU",
    "TRIWEST HEALTHCARE ALLIANCE": null,
  };

  it("matches the SEC list on normalized name", () => {
    const db = dbWithTickers();
    expect(lookupTicker(db, "MOTOROLA SOLUTIONS, INC", overrides)).toBe("MSI");
    expect(lookupTicker(db, "Motorola Solutions Inc.", overrides)).toBe("MSI");
  });

  it("prefers overrides, including explicit null suppression", () => {
    const db = dbWithTickers();
    expect(lookupTicker(db, "American Centrifuge Operating, LLC", overrides)).toBe("LEU");
    expect(lookupTicker(db, "TriWest Healthcare Alliance Corp", overrides)).toBeNull();
  });

  it("returns null for unknown names — no fuzzy guessing", () => {
    const db = dbWithTickers();
    expect(lookupTicker(db, "Motorola Solutions of Delaware", overrides)).toBeNull();
    expect(lookupTicker(db, "", overrides)).toBeNull();
  });
});

describe("enrichSignalTickers", () => {
  it("fills only null-ticker signals and reports the count", () => {
    const db = dbWithTickers();
    insertSignal(db, {
      source: "lda",
      rule: "lobbying.watched-issue",
      dedupeKey: "a",
      company: "MOTOROLA SOLUTIONS INC",
    });
    insertSignal(db, {
      source: "congress",
      rule: "congress.top-band-buy",
      dedupeKey: "b",
      company: "Alphabet Inc.",
      ticker: "GOOG", // already set; must not be overwritten
    });
    insertSignal(db, {
      source: "usaspending",
      rule: "contracts.mega-award",
      dedupeKey: "c",
      company: "Unknown Widgets LLC",
    });

    const filled = enrichSignalTickers(db, {});
    expect(filled).toBe(1);

    const rows = db
      .prepare("SELECT dedupe_key k, ticker FROM signals ORDER BY dedupe_key")
      .all() as { k: string; ticker: string | null }[];
    expect(rows).toEqual([
      { k: "a", ticker: "MSI" },
      { k: "b", ticker: "GOOG" },
      { k: "c", ticker: null },
    ]);
  });
});
