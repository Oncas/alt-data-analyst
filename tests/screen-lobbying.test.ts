import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  lobbyingRules,
  newRegistrationSignals,
  quarterlySpikeSignals,
  watchedIssueSignals,
  type LobbyFilingLike,
} from "../src/screen/lobbying.js";

const baseFiling: LobbyFilingLike = {
  filingUuid: "uuid-1",
  client: "Acme Robotics",
  registrant: "Lobby Shop LLC",
  clientDescription: "Industrial robots",
  filingType: "Q2",
  filingYear: 2026,
  filingPeriod: "second_quarter",
  amountUsd: 400_000,
  issueCodes: ["DEF", "TAX"],
};

const watch = new Set(["DEF", "PHA"]);

describe("watchedIssueSignals", () => {
  it("flags large filings on watched codes, escalating severity at $1M", () => {
    const signals = watchedIssueSignals(
      [baseFiling, { ...baseFiling, filingUuid: "uuid-2", amountUsd: 1_500_000 }],
      { watch, minUsd: 250_000 },
    );
    expect(signals).toHaveLength(2);
    expect(signals[0]?.severity).toBe(2);
    expect(signals[1]?.severity).toBe(3);
    expect(signals[0]?.evidence).toMatchObject({ matchedCodes: ["DEF"] });
  });

  it("ignores unwatched codes, small filings, and null amounts", () => {
    expect(
      watchedIssueSignals([{ ...baseFiling, issueCodes: ["TAX"] }], { watch, minUsd: 250_000 }),
    ).toHaveLength(0);
    expect(
      watchedIssueSignals([{ ...baseFiling, amountUsd: 100_000 }], { watch, minUsd: 250_000 }),
    ).toHaveLength(0);
    expect(
      watchedIssueSignals([{ ...baseFiling, amountUsd: null }], { watch, minUsd: 250_000 }),
    ).toHaveLength(0);
  });
});

describe("newRegistrationSignals", () => {
  it("flags RR filings with a client, skips others", () => {
    const signals = newRegistrationSignals([
      { ...baseFiling, filingType: "RR" },
      { ...baseFiling, filingUuid: "uuid-3", filingType: "Q2" },
      { ...baseFiling, filingUuid: "uuid-4", filingType: "RR", client: null },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.rule).toBe("lobbying.new-registration");
  });
});

describe("quarterlySpikeSignals", () => {
  const opts = { ratio: 2, minCurrent: 100_000, minPriorQuarters: 2 };

  it("flags a latest quarter at >= ratio x the prior average", () => {
    const signals = quarterlySpikeSignals(
      [
        {
          client: "SpikeCo",
          quarters: [
            { quarter: "2025Q4", usd: 50_000 },
            { quarter: "2026Q1", usd: 70_000 },
            { quarter: "2026Q2", usd: 200_000 },
          ],
        },
      ],
      opts,
    );
    expect(signals).toHaveLength(1);
    expect(signals[0]?.evidence).toMatchObject({ quarter: "2026Q2", priorQuarters: 2 });
  });

  it("stays silent without enough prior quarters or below thresholds", () => {
    const shortSeries = {
      client: "NewCo",
      quarters: [
        { quarter: "2026Q1", usd: 50_000 },
        { quarter: "2026Q2", usd: 500_000 },
      ],
    };
    expect(quarterlySpikeSignals([shortSeries], opts)).toHaveLength(0);

    const flat = {
      client: "FlatCo",
      quarters: [
        { quarter: "2025Q4", usd: 100_000 },
        { quarter: "2026Q1", usd: 110_000 },
        { quarter: "2026Q2", usd: 150_000 },
      ],
    };
    expect(quarterlySpikeSignals([flat], opts)).toHaveLength(0);
  });
});

// ---------- end-to-end helpers ----------

function memoryDb(): Db {
  const db = new Database(":memory:") as Db;
  migrate(db);
  return db;
}

function testConfig(): Config {
  return {
    DB_PATH: ":memory:",
    LOBBY_MIN_USD: 250_000,
    WATCH_ISSUE_CODES: "DEF,PHA",
  } as Config;
}

/** Make a client resolvable; the argument is the *normalized* name. */
function seedTicker(db: Db, normalizedName: string, ticker: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO company_tickers (normalized_name, ticker) VALUES (?, ?)",
  ).run(normalizedName, ticker);
}

function seedFiling(db: Db, uuid: string, overrides: Partial<Record<string, unknown>> = {}): void {
  const row = {
    uuid,
    type: "Q2",
    year: 2026,
    period: "second_quarter",
    income: 400_000,
    expenses: null,
    dt: "2026-07-18T12:00:00-04:00",
    registrant: "Lobby Shop LLC",
    client: "Acme Robotics",
    desc: "robots",
    codes: JSON.stringify(["DEF"]),
    ...overrides,
  };
  db.prepare(
    `INSERT INTO lobbying_filings
       (filing_uuid, filing_type, filing_year, filing_period, income, expenses,
        dt_posted, registrant, client, client_description, issue_codes)
     VALUES (@uuid, @type, @year, @period, @income, @expenses, @dt, @registrant,
             @client, @desc, @codes)`,
  ).run(row);
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

describe("lobbyingRules end-to-end", () => {
  it("produces signals from seeded data and is idempotent", () => {
    const db = memoryDb();
    const config = testConfig();
    // Both flagged clients must resolve, or the gated/demoted rules change shape.
    seedTicker(db, "ACME ROBOTICS", "ACME");
    seedTicker(db, "FRESH STARTUP", "FRSH");

    seedFiling(db, "w1"); // watched-issue hit
    seedFiling(db, "r1", { type: "RR", income: null, client: "Fresh Startup Inc" });
    // Spike series for one client across three quarters.
    seedFiling(db, "s1", { client: "SpikeCo", year: 2025, period: "fourth_quarter", income: 50_000, codes: "[]" });
    seedFiling(db, "s2", { client: "SpikeCo", year: 2026, period: "first_quarter", income: 60_000, codes: "[]" });
    seedFiling(db, "s3", { client: "SpikeCo", year: 2026, period: "second_quarter", income: 250_000, codes: "[]" });

    const first = lobbyingRules.map((rule) => rule.run({ db, config }));
    expect(first.reduce((a, b) => a + b, 0)).toBe(3);

    const second = lobbyingRules.map((rule) => rule.run({ db, config }));
    expect(second.reduce((a, b) => a + b, 0)).toBe(0);
  });

  it("stamps the ticker at creation time and keeps severity when the client resolves", () => {
    const db = memoryDb();
    const config = testConfig();
    seedTicker(db, "ACME ROBOTICS", "ACME");
    seedFiling(db, "w1");
    seedFiling(db, "r1", { type: "RR", income: null });

    lobbyingRules.map((rule) => rule.run({ db, config }));

    expect(signalsByRule(db)).toEqual({
      // $400k => severity 2, undemoted because the client resolved.
      "lobbying.watched-issue": [{ severity: 2, ticker: "ACME" }],
      "lobbying.new-registration": [{ severity: 1, ticker: "ACME" }],
    });
  });
});

describe("lobbying ticker gating", () => {
  it("drops new-registration signals whose client has no public ticker", () => {
    const db = memoryDb();
    const config = testConfig();
    seedFiling(db, "r1", {
      type: "RR",
      income: null,
      client: "Chippewa Valley Community College",
      codes: "[]",
    });

    const counts = lobbyingRules.map((rule) => rule.run({ db, config }));
    expect(counts.reduce((a, b) => a + b, 0)).toBe(0);
    expect(signalsByRule(db)).toEqual({});
  });

  it("demotes rather than drops an unresolvable watched-issue filing", () => {
    const db = memoryDb();
    const config = testConfig();
    seedFiling(db, "w1", { client: "Rural County Memorial Fund", income: 1_500_000 });

    lobbyingRules.map((rule) => rule.run({ db, config }));

    // $1.5M would be severity 3; unresolvable knocks it to 2 but keeps it.
    expect(signalsByRule(db)).toEqual({
      "lobbying.watched-issue": [{ severity: 2, ticker: null }],
    });
  });

  it("goes quiet on gated rules when company_tickers is empty, without crashing", () => {
    const db = memoryDb(); // company_tickers exists but has no rows
    const config = testConfig();
    seedFiling(db, "w1"); // watched-issue, severity 2 -> demoted to 1
    seedFiling(db, "r1", { type: "RR", income: null, client: "Fresh Startup Inc" });

    expect(() => lobbyingRules.map((rule) => rule.run({ db, config }))).not.toThrow();
    expect(signalsByRule(db)).toEqual({
      "lobbying.watched-issue": [{ severity: 1, ticker: null }],
    });
  });
});
