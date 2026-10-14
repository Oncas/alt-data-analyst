import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { insertSignal, migrate, type Db } from "../src/db/index.js";
import {
  clusterBuySignals,
  congressRules,
  crossSourceCongressSignals,
  fastFilingSignals,
  topBandBuySignals,
  type CongressBuy,
} from "../src/screen/congress.js";

const baseBuy: CongressBuy = {
  sourceId: "h-1",
  filerName: "Jane Doe",
  chamber: "house",
  office: "CA-12",
  ticker: "NVDA",
  assetName: "NVIDIA Corp",
  transactionDate: "2026-07-10",
  amountLow: 15_001,
  amountLabel: "$15,001 - $50,000",
  daysToFile: 20,
  docUrl: "https://example.gov/x.pdf",
};

describe("clusterBuySignals", () => {
  const opts = { windowEnd: "2026-07-15", windowDays: 14, minMembers: 3 };

  it("flags >=3 distinct members on one ticker, sev 3 at >=5", () => {
    const trio = clusterBuySignals(
      [
        baseBuy,
        { ...baseBuy, sourceId: "h-2", filerName: "Bob Roe" },
        { ...baseBuy, sourceId: "h-3", filerName: "Cara Poe" },
      ],
      opts,
    );
    expect(trio).toHaveLength(1);
    expect(trio[0]?.severity).toBe(2);
    expect(trio[0]?.evidence).toMatchObject({ memberCount: 3 });

    const five = clusterBuySignals(
      ["A", "B", "C", "D", "E"].map((name, i) => ({
        ...baseBuy,
        sourceId: `h-${i}`,
        filerName: name,
      })),
      opts,
    );
    expect(five[0]?.severity).toBe(3);
  });

  it("ignores duplicate members, tickerless rows, and out-of-window trades", () => {
    expect(
      clusterBuySignals(
        [baseBuy, { ...baseBuy, sourceId: "h-2" }, { ...baseBuy, sourceId: "h-3" }],
        opts,
      ),
    ).toHaveLength(0);
    expect(
      clusterBuySignals(
        [
          { ...baseBuy, ticker: null },
          { ...baseBuy, sourceId: "h-2", filerName: "B", ticker: null },
          { ...baseBuy, sourceId: "h-3", filerName: "C", ticker: null },
        ],
        opts,
      ),
    ).toHaveLength(0);
    expect(
      clusterBuySignals(
        [
          { ...baseBuy, transactionDate: "2026-06-01" },
          { ...baseBuy, sourceId: "h-2", filerName: "B", transactionDate: "2026-06-02" },
          { ...baseBuy, sourceId: "h-3", filerName: "C", transactionDate: "2026-06-03" },
        ],
        opts,
      ),
    ).toHaveLength(0);
  });
});

describe("topBandBuySignals", () => {
  it("flags $1M+ band purchases only", () => {
    const signals = topBandBuySignals(
      [baseBuy, { ...baseBuy, sourceId: "h-2", amountLow: 1_000_001, amountLabel: "$1,000,001 - $5,000,000" }],
      1_000_000,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe(3);
    expect(signals[0]?.evidence).toMatchObject({ amountLabel: "$1,000,001 - $5,000,000" });
  });
});

describe("crossSourceCongressSignals", () => {
  it("joins on ticker or normalized asset name", () => {
    const others = [
      { source: "usaspending", rule: "contracts.mega-award", company: "NVIDIA CORP", ticker: null },
    ];
    expect(crossSourceCongressSignals([baseBuy], others)).toHaveLength(1);
    expect(
      crossSourceCongressSignals([{ ...baseBuy, ticker: "XYZ", assetName: "Other Co" }], others),
    ).toHaveLength(0);
  });
});

describe("fastFilingSignals", () => {
  const opts = { maxDays: 3, minLowUsd: 15_001 };

  it("flags prompt disclosures of meaningful buys", () => {
    const signals = fastFilingSignals([{ ...baseBuy, daysToFile: 1 }], opts);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe(1);
  });

  it("ignores slow filings, micro buys, and missing data", () => {
    expect(fastFilingSignals([baseBuy], opts)).toHaveLength(0);
    expect(
      fastFilingSignals([{ ...baseBuy, daysToFile: 1, amountLow: 1_001 }], opts),
    ).toHaveLength(0);
    expect(fastFilingSignals([{ ...baseBuy, daysToFile: null }], opts)).toHaveLength(0);
  });

  it("ignores non-equity assets (no ticker) — T-bill parking is not a signal", () => {
    expect(
      fastFilingSignals(
        [{ ...baseBuy, daysToFile: 0, ticker: null, assetName: "Treasury Bill (3-Month)" }],
        opts,
      ),
    ).toHaveLength(0);
    expect(
      topBandBuySignals(
        [{ ...baseBuy, ticker: null, amountLow: 1_000_001, assetName: "Treasury Note" }],
        1_000_000,
      ),
    ).toHaveLength(0);
  });
});

describe("congressRules end-to-end", () => {
  it("produces signals from seeded data and is idempotent", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    const config = { DB_PATH: ":memory:" } as Config;

    const insert = db.prepare(
      `INSERT INTO congress_trades
         (source_id, filer_name, chamber, office, ticker, asset_name,
          transaction_type, transaction_date, amount_low, amount_label, days_to_file)
       VALUES (?, ?, 'house', 'CA-12', ?, ?, ?, ?, ?, ?, ?)`,
    );
    // Cluster: 3 members buy NVDA within days of each other.
    insert.run("c1", "Jane Doe", "NVDA", "NVIDIA Corp", "purchase", "2026-07-10", 15001, "$15,001 - $50,000", 20);
    insert.run("c2", "Bob Roe", "NVDA", "NVIDIA Corp", "purchase", "2026-07-11", 50001, "$50,001 - $100,000", 25);
    insert.run("c3", "Cara Poe", "NVDA", "NVIDIA Corp", "purchase", "2026-07-12", 15001, "$15,001 - $50,000", 2);
    // Top band + old sale that must not signal.
    insert.run("t1", "Rich Filer", "MSFT", "Microsoft Corp", "purchase", "2026-07-05", 1000001, "$1,000,001 - $5,000,000", 30);
    insert.run("s1", "Jane Doe", "AAPL", "Apple Inc", "sale (full)", "2026-07-09", 15001, "$15,001 - $50,000", 10);
    // Contract signal for a traded company -> cross-source.
    insertSignal(db, {
      source: "usaspending",
      rule: "contracts.mega-award",
      dedupeKey: "x",
      company: "MICROSOFT CORP",
    });

    const first = congressRules.map((rule) => rule.run({ db, config }));
    // cluster 1, top-band 1, cross-source 1 (MSFT), fast-filing 1 (c3, 2 days)
    expect(first).toEqual([1, 1, 1, 1]);

    const second = congressRules.map((rule) => rule.run({ db, config }));
    expect(second.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
