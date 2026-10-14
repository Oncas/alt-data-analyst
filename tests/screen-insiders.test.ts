import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { insertSignal, migrate, type Db } from "../src/db/index.js";
import {
  bigExecBuySignals,
  clusterBuySignals,
  crossSourceBuySignals,
  insiderRules,
  type InsiderBuy,
} from "../src/screen/insiders.js";
import { normalizeCompanyName } from "../src/util/companies.js";

const baseBuy: InsiderBuy = {
  accession: "acc-1",
  txnIndex: 0,
  ticker: "ACME",
  issuerName: "Acme Robotics, Inc.",
  insiderName: "DOE JANE",
  insiderRole: "Chief Executive Officer",
  transactionDate: "2026-07-14",
  value: 300_000,
};

describe("normalizeCompanyName", () => {
  it("strips punctuation and legal suffixes, keeps distinguishing words", () => {
    expect(normalizeCompanyName("Acme Robotics, Inc.")).toBe("ACME ROBOTICS");
    expect(normalizeCompanyName("ACME ROBOTICS INC")).toBe("ACME ROBOTICS");
    expect(normalizeCompanyName("Voyager Space Holdings, Inc.")).toBe("VOYAGER SPACE HOLDINGS");
    expect(normalizeCompanyName("Smith & Wesson Corp.")).toBe("SMITH WESSON");
  });
});

describe("clusterBuySignals", () => {
  const opts = { windowEnd: "2026-07-15", windowDays: 14, minInsiders: 2 };

  it("flags >=2 distinct insiders on one ticker in-window", () => {
    const signals = clusterBuySignals(
      [
        baseBuy,
        { ...baseBuy, accession: "acc-2", insiderName: "ROE RICHARD", value: 100_000 },
      ],
      opts,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.evidence).toMatchObject({ insiderCount: 2, totalUsd: 400_000 });
    expect(signals[0]?.severity).toBe(2);
  });

  it("escalates severity for 3+ insiders and ignores out-of-window or repeat buys", () => {
    const trio = clusterBuySignals(
      [
        baseBuy,
        { ...baseBuy, accession: "a2", insiderName: "B" },
        { ...baseBuy, accession: "a3", insiderName: "C" },
      ],
      opts,
    );
    expect(trio[0]?.severity).toBe(3);

    const sameInsiderTwice = clusterBuySignals(
      [baseBuy, { ...baseBuy, accession: "a2" }],
      opts,
    );
    expect(sameInsiderTwice).toHaveLength(0);

    const stale = clusterBuySignals(
      [baseBuy, { ...baseBuy, accession: "a2", insiderName: "B", transactionDate: "2026-06-01" }],
      opts,
    );
    expect(stale).toHaveLength(0);
  });

  it("ignores clusters below the dollar floor", () => {
    const tiny = clusterBuySignals(
      [
        { ...baseBuy, value: 8_000 },
        { ...baseBuy, accession: "a2", insiderName: "B", value: 9_000 },
      ],
      opts,
    );
    expect(tiny).toHaveLength(0);
  });
});

describe("bigExecBuySignals", () => {
  it("flags exec buys at/above the floor, sev 3 at $1M", () => {
    const signals = bigExecBuySignals(
      [baseBuy, { ...baseBuy, accession: "a2", value: 1_500_000 }],
      250_000,
    );
    expect(signals).toHaveLength(2);
    expect(signals[1]?.severity).toBe(3);
  });

  it("ignores non-execs and small buys", () => {
    expect(
      bigExecBuySignals([{ ...baseBuy, insiderRole: "Director" }], 250_000),
    ).toHaveLength(0);
    expect(bigExecBuySignals([{ ...baseBuy, value: 100_000 }], 250_000)).toHaveLength(0);
    expect(bigExecBuySignals([{ ...baseBuy, insiderRole: null }], 250_000)).toHaveLength(0);
  });

  it("matches President in compound roles", () => {
    const signals = bigExecBuySignals(
      [{ ...baseBuy, insiderRole: "President, Director, 10% owner" }],
      250_000,
    );
    expect(signals).toHaveLength(1);
  });
});

describe("crossSourceBuySignals", () => {
  const contractSignal = {
    source: "usaspending",
    rule: "contracts.mega-award",
    company: "ACME ROBOTICS INC",
    ticker: null,
  };

  it("joins on normalized company name when the other signal lacks a ticker", () => {
    const signals = crossSourceBuySignals([baseBuy], [contractSignal], 50_000);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.severity).toBe(3);
    expect(signals[0]?.evidence).toMatchObject({ otherRule: "contracts.mega-award" });
  });

  it("prefers ticker joins and respects the minimum buy size", () => {
    const tickerMatch = crossSourceBuySignals(
      [baseBuy],
      [{ source: "congress", rule: "congress.cluster", company: null, ticker: "acme" }],
      50_000,
    );
    expect(tickerMatch).toHaveLength(1);

    expect(
      crossSourceBuySignals([{ ...baseBuy, value: 10_000 }], [contractSignal], 50_000),
    ).toHaveLength(0);
    expect(
      crossSourceBuySignals(
        [{ ...baseBuy, issuerName: "Unrelated Co", ticker: "XYZ" }],
        [contractSignal],
        50_000,
      ),
    ).toHaveLength(0);
  });
});

describe("insiderRules end-to-end", () => {
  it("produces signals from seeded data and is idempotent", () => {
    const db = new Database(":memory:") as Db;
    migrate(db);
    const config = { DB_PATH: ":memory:", INSIDER_BIG_BUY_USD: 250_000 } as Config;

    const insert = db.prepare(
      `INSERT INTO insider_trades
         (accession, txn_index, ticker, issuer_name, insider_name, insider_role,
          transaction_code, transaction_date, shares, price, value)
       VALUES (?, ?, ?, ?, ?, ?, 'P', ?, 100, 10, ?)`,
    );
    insert.run("e1", 0, "ACME", "Acme Robotics, Inc.", "DOE JANE", "Chief Executive Officer", "2026-07-14", 400_000);
    insert.run("e2", 0, "ACME", "Acme Robotics, Inc.", "ROE RICHARD", "Director", "2026-07-13", 60_000);
    // A contract signal for the same company -> cross-source hit.
    insertSignal(db, {
      source: "usaspending",
      rule: "contracts.mega-award",
      dedupeKey: "x",
      company: "ACME ROBOTICS INC",
    });

    const first = insiderRules.map((rule) => rule.run({ db, config }));
    // cluster (2 insiders), big-exec-buy (CEO $400k), cross-source (both buys match)
    expect(first).toEqual([1, 1, 2]);

    const second = insiderRules.map((rule) => rule.run({ db, config }));
    expect(second.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
