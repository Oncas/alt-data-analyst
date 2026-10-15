import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { migrate, type Db, type SignalInput } from "../src/db/index.js";
import type { OverrideMap } from "../src/enrich/tickers.js";
import {
  applyTickerPolicy,
  createTickerResolver,
  TICKER_POLICY,
  type UnresolvedPolicy,
} from "../src/screen/tickerPolicy.js";

function dbWithTickers(entries: [string, string][] = [["ACME ROBOTICS", "ACME"]]): Db {
  const db = new Database(":memory:") as Db;
  migrate(db);
  const insert = db.prepare(
    "INSERT OR IGNORE INTO company_tickers (normalized_name, ticker) VALUES (?, ?)",
  );
  for (const [name, ticker] of entries) insert.run(name, ticker);
  return db;
}

function signal(rule: string, company: string, severity = 2): SignalInput {
  return { source: "test", rule, dedupeKey: `${rule}|${company}`, company, severity };
}

/** Explicit map so these tests never depend on config/ticker-overrides.json. */
const noOverrides: OverrideMap = {};

describe("TICKER_POLICY", () => {
  it("declares the four measured low-resolution rules and nothing else", () => {
    expect(TICKER_POLICY).toEqual({
      "lobbying.new-registration": "drop",
      "contracts.new-large-recipient": "drop",
      "lobbying.watched-issue": "demote",
      "contracts.mega-award": "demote",
    } satisfies Record<string, UnresolvedPolicy>);
  });
});

describe("createTickerResolver", () => {
  it("resolves via the company_tickers table on normalized name", () => {
    const resolve = createTickerResolver(dbWithTickers(), noOverrides);
    expect(resolve("Acme Robotics, Inc.")).toBe("ACME");
    expect(resolve("Acme Robotics")).toBe("ACME");
  });

  it("treats an override mapped to null as unresolvable, beating the table", () => {
    const db = dbWithTickers([["BATTELLE ENERGY ALLIANCE", "XXX"]]);
    const resolve = createTickerResolver(db, { "BATTELLE ENERGY ALLIANCE": null });
    expect(resolve("Battelle Energy Alliance, LLC")).toBeNull();
  });

  it("returns null for unknown names and missing companies", () => {
    const resolve = createTickerResolver(dbWithTickers(), noOverrides);
    expect(resolve("Chippewa Valley Community College")).toBeNull();
    expect(resolve(undefined)).toBeNull();
    expect(resolve("")).toBeNull();
  });

  it("looks each distinct name up once, however many rows carry it", () => {
    const db = dbWithTickers();
    const realPrepare = db.prepare.bind(db);
    let queries = 0;
    // Real statements, counted calls: proves the per-row lookup is memoized.
    const counting = {
      prepare: (sql: string) => {
        queries++;
        return realPrepare(sql);
      },
    } as unknown as Db;

    const resolve = createTickerResolver(counting, noOverrides);
    for (let i = 0; i < 50; i++) resolve("Acme Robotics");
    for (let i = 0; i < 50; i++) resolve("Chippewa Valley Community College");
    expect(queries).toBe(2);
  });
});

describe("applyTickerPolicy", () => {
  const resolvable = createTickerResolver(dbWithTickers(), noOverrides);

  it("carries the ticker onto resolvable signals", () => {
    const out = applyTickerPolicy([signal("lobbying.new-registration", "Acme Robotics")], resolvable);
    expect(out).toHaveLength(1);
    expect(out[0]?.ticker).toBe("ACME");
  });

  it("drops unresolvable signals from gated rules", () => {
    const out = applyTickerPolicy(
      [
        signal("lobbying.new-registration", "Chippewa Valley Community College"),
        signal("contracts.new-large-recipient", "Savannah River Nuclear Solutions"),
      ],
      resolvable,
    );
    expect(out).toHaveLength(0);
  });

  it("demotes rather than drops unresolvable signals from demotion rules", () => {
    const out = applyTickerPolicy(
      [
        signal("lobbying.watched-issue", "Memorial Fund Trust", 3),
        signal("contracts.mega-award", "UT-Battelle", 2),
      ],
      resolvable,
    );
    expect(out.map((s) => s.severity)).toEqual([2, 1]);
    expect(out.every((s) => s.ticker === undefined)).toBe(true);
  });

  it("floors demoted severity at 1", () => {
    const out = applyTickerPolicy([signal("contracts.mega-award", "Nobody", 1)], resolvable);
    expect(out[0]?.severity).toBe(1);
    const defaulted = applyTickerPolicy(
      [{ source: "test", rule: "contracts.mega-award", dedupeKey: "d", company: "Nobody" }],
      resolvable,
    );
    expect(defaulted[0]?.severity).toBe(1);
  });

  it("leaves severity intact when a demotion rule's company resolves", () => {
    const out = applyTickerPolicy([signal("contracts.mega-award", "Acme Robotics", 3)], resolvable);
    expect(out[0]).toMatchObject({ severity: 3, ticker: "ACME" });
  });

  it("passes rules with no declared policy through untouched", () => {
    const input = [signal("lobbying.quarterly-spike", "Chippewa Valley Community College", 2)];
    expect(applyTickerPolicy(input, resolvable)).toEqual(input);
  });

  it("goes quiet instead of crashing when company_tickers is empty", () => {
    const empty = createTickerResolver(dbWithTickers([]), noOverrides);
    const out = applyTickerPolicy(
      [
        signal("lobbying.new-registration", "Acme Robotics"),
        signal("contracts.mega-award", "Acme Robotics", 3),
      ],
      empty,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ rule: "contracts.mega-award", severity: 2 });
  });
});
