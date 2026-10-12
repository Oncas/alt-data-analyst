import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { insertSignal, migrate, type Db } from "../src/db/index.js";
import {
  buildDigest,
  fmtUsd,
  formatEvidence,
  markSignalsReported,
  unreportedSignals,
} from "../src/report/digest.js";

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("fmtUsd", () => {
  it("scales to B/M and plain dollars", () => {
    expect(fmtUsd(1_313_227_200)).toBe("$1.31B");
    expect(fmtUsd(22_000_000)).toBe("$22.0M");
    expect(fmtUsd(950_000)).toBe("$950,000");
  });
});

describe("formatEvidence", () => {
  it("uses the rule-specific formatter when registered", () => {
    const line = formatEvidence(
      "contracts.mega-award",
      JSON.stringify({
        amount: 400_000_000,
        agency: "DoD",
        description: "widgets",
        awardId: "AW1",
        actionDate: "2026-07-10",
      }),
    );
    expect(line).toContain("$400.0M");
    expect(line).toContain("DoD");
    expect(line).toContain("AW1");
  });

  it("falls back to compact JSON for unknown rules", () => {
    const line = formatEvidence("future.rule", JSON.stringify({ a: 1 }));
    expect(line).toBe('{"a":1}');
  });

  it("passes through malformed JSON untouched", () => {
    expect(formatEvidence("contracts.mega-award", "not-json")).toBe("not-json");
  });

  it("omits caveats for evidence written by older rule versions", () => {
    const line = formatEvidence(
      "contracts.new-large-recipient",
      JSON.stringify({ firstSeen: "2026-07-07", awardCount: 4, totalUsd: 24_900_000, largestAwardUsd: 7_000_000 }),
    );
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("caveat");
  });
});

describe("buildDigest", () => {
  const base = {
    id: 1,
    source: "usaspending",
    rule: "contracts.mega-award",
    company: "BIGCO",
    ticker: null,
    severity: 2,
    evidence: JSON.stringify({
      amount: 300_000_000,
      agency: "DoD",
      description: "x",
      awardId: "AW1",
      actionDate: "2026-07-01",
    }),
    created_at: "2026-07-19 12:00:00",
  };

  it("groups by rule with counts and always carries the disclaimer", () => {
    const digest = buildDigest(
      [base, { ...base, id: 2, rule: "future.rule", evidence: "{}" }],
      { generatedAt: "2026-07-19", freshness: ["usaspending → 2026-07-19"] },
    );
    expect(digest).toContain("# Alt-data digest — 2026-07-19");
    expect(digest).toContain("2 new signal(s): contracts.mega-award 1, future.rule 1");
    expect(digest).toContain("## contracts.mega-award (1)");
    expect(digest).toContain("**BIGCO**");
    expect(digest).toContain("not investment advice");
  });

  it("handles the empty case", () => {
    const digest = buildDigest([], { generatedAt: "2026-07-19", freshness: [] });
    expect(digest).toContain("No new signals since the last report.");
    expect(digest).toContain("not investment advice");
  });

  it("shows tickers next to companies when present", () => {
    const digest = buildDigest([{ ...base, ticker: "BIG" }], {
      generatedAt: "2026-07-19",
      freshness: [],
    });
    expect(digest).toContain("**BIGCO [BIG]**");
  });
});

describe("report watermark", () => {
  it("unreported → marked → gone, ordered by severity", () => {
    const db = memoryDb();
    insertSignal(db, { source: "s", rule: "r1", dedupeKey: "a", severity: 1 });
    insertSignal(db, { source: "s", rule: "r2", dedupeKey: "b", severity: 3 });

    const pending = unreportedSignals(db);
    expect(pending.map((signal) => signal.severity)).toEqual([3, 1]);

    markSignalsReported(db, pending.map((signal) => signal.id));
    expect(unreportedSignals(db)).toHaveLength(0);
  });
});
