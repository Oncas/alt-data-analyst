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
    // Baseline history (well before any window), then recent activity.
    seedContract(db, "old1", "STALWART INC", 8_000_000, "2026-01-10");
    seedContract(db, "old2", "SPIKECO", 6_000_000, "2026-02-15");
    // Mega award.
    seedContract(db, "mega", "BIGCO", 400_000_000, "2026-07-10");
    // New recipient inside the 14-day window with > $20M.
    seedContract(db, "new1", "FRESHCO", 22_000_000, "2026-07-12");
    // Spike: prior window ~Feb-Apr vs current window Apr-Jul.
    seedContract(db, "sp1", "SPIKECO", 30_000_000, "2026-07-01");

    const firstRun = contractRules.map((rule) => rule.run({ db, config }));
    expect(firstRun.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(2);

    const secondRun = contractRules.map((rule) => rule.run({ db, config }));
    expect(secondRun.reduce((a, b) => a + b, 0)).toBe(0);
  });
});
