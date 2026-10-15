import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  contractRules,
  megaAwardSignals,
  newRecipientSignals,
  spendSpikeSignals,
  type MegaAwardRow,
} from "../src/screen/contracts.js";

function testConfig(): Config {
  return {
    DB_PATH: ":memory:",
    MIN_CONTRACT_USD: 5_000_000,
    MEGA_CONTRACT_USD: 250_000_000,
  } as Config;
}

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function seedContract(
  db: Db,
  key: string,
  recipient: string,
  amount: number,
  actionDate: string,
): void {
  db.prepare(
    `INSERT INTO contracts (natural_key, award_id, recipient, amount, action_date)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(key, `AW-${key}`, recipient, amount, actionDate);
}

/** Make a recipient resolvable; the argument is the *normalized* name. */
function seedTicker(db: Db, normalizedName: string, ticker: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO company_tickers (normalized_name, ticker) VALUES (?, ?)",
  ).run(normalizedName, ticker);
}

function signalsByRule(db: Db): Record<string, { severity: number; ticker: string | null }[]> {
  const rows = db
    .prepare("SELECT rule, severity, ticker FROM signals ORDER BY rule, dedupe_key")
    .all() as { rule: string; severity: number; ticker: string | null }[];
  const out: Record<string, { severity: number; ticker: string | null }[]> = {};
  for (const { rule, severity, ticker } of rows) {
    (out[rule] ??= []).push({ severity, ticker });
  }
  return out;
}

/** Baseline history plus one mega award and one brand-new large recipient. */
function seedStandardContracts(db: Db): void {
  seedContract(db, "old1", "STALWART INC", 8_000_000, "2026-01-10");
  seedContract(db, "old2", "SPIKECO", 6_000_000, "2026-02-15");
  seedContract(db, "mega", "BIGCO", 400_000_000, "2026-07-10");
  seedContract(db, "new1", "FRESHCO", 22_000_000, "2026-07-12");
  seedContract(db, "sp1", "SPIKECO", 30_000_000, "2026-07-01");
}

const megaRow: MegaAwardRow = {
  naturalKey: "usa:1",
  awardId: "AW1",
  recipient: "BIGCO",
  amount: 300_000_000,
  actionDate: "2026-07-01",
  awardingAgency: "DoD",
  description: "things",
};

describe("megaAwardSignals", () => {
  it("flags awards at or above the threshold, tiering severity at $1B", () => {
    const rows = [
      megaRow,
      { ...megaRow, naturalKey: "usa:2", amount: 1_300_000_000 },
      { ...megaRow, naturalKey: "usa:3", amount: 249_999_999 },
    ];
    const signals = megaAwardSignals(rows, 250_000_000);
    expect(signals).toHaveLength(2);
    expect(signals[0]?.severity).toBe(2);
    expect(signals[1]?.severity).toBe(3);
  });
});

describe("newRecipientSignals", () => {
  const agg = {
    recipient: "FRESHCO",
    firstSeen: "2026-07-10",
    total: 30_000_000,
    awardCount: 2,
    topAmount: 25_000_000,
  };
  const opts = {
    windowStart: "2026-07-05",
    dbFirstDate: "2026-06-01",
    minTotal: 20_000_000,
  };

  it("flags first-seen-in-window recipients above the total floor", () => {
    const signals = newRecipientSignals([agg], opts);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.dedupeKey).toBe("FRESHCO|2026-07-10");
  });

  it("ignores recipients seen before the window or below the floor", () => {
    expect(newRecipientSignals([{ ...agg, firstSeen: "2026-06-20" }], opts)).toHaveLength(0);
    expect(newRecipientSignals([{ ...agg, total: 19_999_999 }], opts)).toHaveLength(0);
  });

  it("returns nothing when the db has no baseline predating the window", () => {
    const signals = newRecipientSignals([agg], { ...opts, dbFirstDate: "2026-07-05" });
    expect(signals).toHaveLength(0);
  });
});

describe("spendSpikeSignals", () => {
  const opts = {
    ratio: 3,
    minCurrent: 20_000_000,
    minPrior: 5_000_000,
    bucket: "2026-07",
  };

  it("flags recipients whose current window is >= ratio x prior", () => {
    const signals = spendSpikeSignals(
      [{ recipient: "SPIKECO", currentUsd: 60_000_000, priorUsd: 10_000_000 }],
      opts,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.evidence).toMatchObject({ ratio: 6 });
  });

  it("ignores small priors (no baseline), small currents, and sub-ratio growth", () => {
    expect(
      spendSpikeSignals([{ recipient: "A", currentUsd: 60_000_000, priorUsd: 1_000_000 }], opts),
    ).toHaveLength(0);
    expect(
      spendSpikeSignals([{ recipient: "B", currentUsd: 15_000_000, priorUsd: 5_000_000 }], opts),
    ).toHaveLength(0);
    expect(
      spendSpikeSignals([{ recipient: "C", currentUsd: 25_000_000, priorUsd: 10_000_000 }], opts),
    ).toHaveLength(0);
  });
});

describe("contractRules end-to-end", () => {
  it("produces signals from seeded data and is idempotent on re-run", () => {
    const db = memoryDb();
    const config = testConfig();
    // Recipients must resolve, or the gated rule drops them (see gating tests).
    seedTicker(db, "BIGCO", "BIG");
    seedTicker(db, "FRESHCO", "FRSH");
    seedStandardContracts(db);

    const firstRun = contractRules.map((rule) => rule.run({ db, config }));
    expect(firstRun.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);

    const secondRun = contractRules.map((rule) => rule.run({ db, config }));
    expect(secondRun.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("stamps the ticker at creation time and keeps severity when the recipient resolves", () => {
    const db = memoryDb();
    const config = testConfig();
    seedTicker(db, "BIGCO", "BIG");
    seedTicker(db, "FRESHCO", "FRSH");
    seedStandardContracts(db);

    contractRules.map((rule) => rule.run({ db, config }));

    expect(signalsByRule(db)).toEqual({
      // $400M => severity 2, undemoted because the recipient resolved.
      "contracts.mega-award": [{ severity: 2, ticker: "BIG" }],
      // BIGCO is also first-seen inside the window, alongside FRESHCO.
      "contracts.new-large-recipient": [
        { severity: 2, ticker: "BIG" },
        { severity: 2, ticker: "FRSH" },
      ],
      // Not policy-governed: passes through with no ticker until enrichment.
      "contracts.spend-spike": [{ severity: 2, ticker: null }],
    });
  });
});

describe("contracts ticker gating", () => {
  it("drops new-large-recipient signals whose recipient has no public ticker", () => {
    const db = memoryDb();
    const config = testConfig();
    seedStandardContracts(db);

    contractRules.map((rule) => rule.run({ db, config }));

    const byRule = signalsByRule(db);
    expect(byRule["contracts.new-large-recipient"]).toBeUndefined();
  });

  it("demotes rather than drops an unresolvable mega award", () => {
    const db = memoryDb();
    const config = testConfig();
    seedStandardContracts(db);

    contractRules.map((rule) => rule.run({ db, config }));

    // A $400M award to a private recipient is still context worth keeping.
    expect(signalsByRule(db)["contracts.mega-award"]).toEqual([{ severity: 1, ticker: null }]);
  });

  it("gates on resolution independently per recipient", () => {
    const db = memoryDb();
    const config = testConfig();
    seedTicker(db, "FRESHCO", "FRSH"); // BIGCO deliberately left unresolvable
    seedStandardContracts(db);

    contractRules.map((rule) => rule.run({ db, config }));

    expect(signalsByRule(db)["contracts.new-large-recipient"]).toEqual([
      { severity: 2, ticker: "FRSH" },
    ]);
    expect(signalsByRule(db)["contracts.mega-award"]).toEqual([{ severity: 1, ticker: null }]);
  });

  it("goes quiet on gated rules when company_tickers is empty, without crashing", () => {
    const db = memoryDb(); // company_tickers exists but has no rows
    const config = testConfig();
    seedStandardContracts(db);

    expect(() => contractRules.map((rule) => rule.run({ db, config }))).not.toThrow();
    expect(Object.keys(signalsByRule(db)).sort()).toEqual([
      "contracts.mega-award",
      "contracts.spend-spike",
    ]);
  });
});
