import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { insertSignal, migrate, type Db } from "../src/db/index.js";
import {
  buildDigest,
  evidenceAgeDays,
  fmtUsd,
  formatEvidence,
  markSignalsReported,
  MAX_LINES_PER_RULE,
  registerEvidenceFormatter,
  unreportedSignals,
} from "../src/report/digest.js";
import { DEFAULT_TIER, tierFor } from "../src/report/tiers.js";
// Rule modules register their evidence formatters at import time.
import "../src/screen/contracts.js";

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

  it("does not hand non-object evidence to a formatter", () => {
    // A formatter reading .amount off null would throw and kill the whole digest.
    expect(formatEvidence("contracts.mega-award", "null")).toBe("null");
    expect(formatEvidence("contracts.mega-award", "[1,2]")).toBe("[1,2]");
  });

  it("falls back to raw evidence when a formatter throws", () => {
    registerEvidenceFormatter("explodes.rule", (e) => (e.missing as string[]).join(","));
    expect(formatEvidence("explodes.rule", '{"a":1}')).toBe('{"a":1}');
  });

  it("scrubs placeholder tokens a formatter interpolated from absent fields", () => {
    const line = formatEvidence("contracts.mega-award", JSON.stringify({ agency: "DoD" }));
    expect(line).not.toContain("undefined");
    expect(line).not.toContain("NaN");
    expect(line).toContain("DoD");
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

describe("tierFor", () => {
  it("puts cross-source correlations in the lead tier", () => {
    expect(tierFor("13f.cross-source-position")).toBe("lead");
    expect(tierFor("congress.cross-source-buy")).toBe("lead");
    expect(tierFor("insiders.cross-source-buy")).toBe("lead");
  });

  it("keeps single-source discovery in the standard tier", () => {
    expect(tierFor("insiders.big-exec-buy")).toBe("standard");
    expect(tierFor("congress.top-band-buy")).toBe("standard");
    expect(tierFor("13f.big-new-position")).toBe("standard");
  });

  it("demotes contracts and lobbying to confirmation", () => {
    expect(tierFor("contracts.mega-award")).toBe("confirmation");
    expect(tierFor("contracts.new-large-recipient")).toBe("confirmation");
    expect(tierFor("lobbying.watched-issue")).toBe("confirmation");
    expect(tierFor("lobbying.new-registration")).toBe("confirmation");
  });

  it("routes every meta.* rule to the meta tier", () => {
    expect(tierFor("meta.source-stale")).toBe("meta");
    expect(tierFor("meta.some-future-health-check")).toBe("meta");
  });

  it("degrades unknown rules to the default tier instead of dropping them", () => {
    expect(tierFor("future.rule")).toBe(DEFAULT_TIER);
    expect(tierFor("")).toBe(DEFAULT_TIER);
    // Even nonsense from an old signals row must resolve to a real tier.
    expect(tierFor(undefined as unknown as string)).toBe(DEFAULT_TIER);
  });

  it("infers a tier for unclassified rules from their shape", () => {
    expect(tierFor("contracts.some-new-rule")).toBe("confirmation");
    expect(tierFor("lobbying.some-new-rule")).toBe("confirmation");
    expect(tierFor("newsource.cross-source-thing")).toBe("lead");
  });
});

describe("evidenceAgeDays", () => {
  it("measures from the evidence date to the digest date", () => {
    expect(evidenceAgeDays({ actionDate: "2026-06-27" }, "2026-07-20")).toBe(23);
    expect(evidenceAgeDays({ date: "2026-07-20" }, "2026-07-20")).toBe(0);
  });

  it("returns null rather than NaN for missing or malformed dates", () => {
    expect(evidenceAgeDays({}, "2026-07-20")).toBeNull();
    expect(evidenceAgeDays({ date: null }, "2026-07-20")).toBeNull();
    expect(evidenceAgeDays({ date: "unknown" }, "2026-07-20")).toBeNull();
    expect(evidenceAgeDays({ date: "2026-13-45" }, "2026-07-20")).toBeNull();
    expect(evidenceAgeDays({ date: 20260720 }, "2026-07-20")).toBeNull();
    expect(evidenceAgeDays({ date: "2026-07-01" }, "not-a-date")).toBeNull();
  });

  it("skips future-dated evidence instead of reporting negative age", () => {
    expect(evidenceAgeDays({ date: "2027-01-01" }, "2026-07-20")).toBeNull();
    // …and keeps looking for a usable date on the same evidence object.
    expect(evidenceAgeDays({ date: "2027-01-01", lastDate: "2026-07-10" }, "2026-07-20")).toBe(10);
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

  const meta = { generatedAt: "2026-07-19", freshness: [] as string[] };

  it("groups by rule with counts and always carries the disclaimer", () => {
    const digest = buildDigest([base, { ...base, id: 2, rule: "future.rule", evidence: "{}" }], {
      generatedAt: "2026-07-19",
      freshness: ["usaspending → 2026-07-19"],
    });
    expect(digest).toContain("# Alt-data digest — 2026-07-19");
    expect(digest).toContain("2 new signal(s) — standard 1 · confirmation 1");
    expect(digest).toContain("### contracts.mega-award (1)");
    expect(digest).toContain("### future.rule (1)");
    expect(digest).toContain("**BIGCO**");
    expect(digest).toContain("not investment advice");
  });

  it("orders sections lead → standard → confirmation, ignoring severity", () => {
    // The confirmation item outranks the lead item on severity on purpose.
    const digest = buildDigest(
      [
        { ...base, id: 1, rule: "contracts.mega-award", severity: 3 },
        { ...base, id: 2, rule: "insiders.big-exec-buy", severity: 2, evidence: "{}" },
        { ...base, id: 3, rule: "congress.cross-source-buy", severity: 1, evidence: "{}" },
      ],
      meta,
    );
    const lead = digest.indexOf("## Lead");
    const standard = digest.indexOf("## Standard");
    const confirmation = digest.indexOf("## Confirmation");
    expect(lead).toBeGreaterThan(-1);
    expect(lead).toBeLessThan(standard);
    expect(standard).toBeLessThan(confirmation);
  });

  it("labels the confirmation tier as already-public", () => {
    const digest = buildDigest([base], meta);
    expect(digest).toContain("## Confirmation / already-public");
    expect(digest).toMatch(/press release|8-K/);
  });

  it("keeps pipeline health conspicuous and above the findings", () => {
    const digest = buildDigest(
      [
        { ...base, id: 1, rule: "congress.cross-source-buy", severity: 3, evidence: "{}" },
        {
          ...base,
          id: 2,
          rule: "meta.source-stale",
          severity: 1,
          company: null,
          evidence: JSON.stringify({ source: "congress", newestDate: "2026-06-01", thresholdDays: 7 }),
        },
      ],
      meta,
    );
    expect(digest).toContain("## ⚠ Pipeline health (1)");
    expect(digest.indexOf("Pipeline health")).toBeLessThan(digest.indexOf("## Lead"));
  });

  it("sorts rule groups inside a tier by severity", () => {
    const digest = buildDigest(
      [
        { ...base, id: 1, rule: "congress.fast-filing", severity: 1, evidence: "{}" },
        { ...base, id: 2, rule: "insiders.big-exec-buy", severity: 3, evidence: "{}" },
      ],
      meta,
    );
    expect(digest.indexOf("### insiders.big-exec-buy")).toBeLessThan(
      digest.indexOf("### congress.fast-filing"),
    );
  });

  it("handles the empty case", () => {
    const digest = buildDigest([], { generatedAt: "2026-07-19", freshness: [] });
    expect(digest).toContain("No new signals since the last report.");
    expect(digest).toContain("not investment advice");
  });

  it("caps chatty rule groups and points to the signals table", () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: i + 1,
      rule: "chatty.rule",
      evidence: "{}",
    }));
    const digest = buildDigest(many, { generatedAt: "2026-07-20", freshness: [] });
    expect(digest).toContain("### chatty.rule (20)");
    expect(digest).toContain(`…and ${20 - MAX_LINES_PER_RULE} more (see signals table)`);
    const bullets = digest.split("\n").filter((line) => line.startsWith("- [sev"));
    expect(bullets).toHaveLength(MAX_LINES_PER_RULE);
  });

  it("caps each rule independently so one chatty rule can't crowd out another", () => {
    const chatty = Array.from({ length: 20 }, (_, i) => ({
      ...base,
      id: i + 1,
      rule: "lobbying.new-registration",
      evidence: "{}",
    }));
    const digest = buildDigest([...chatty, { ...base, id: 99, rule: "insiders.big-exec-buy", evidence: "{}" }], meta);
    expect(digest).toContain("### lobbying.new-registration (20)");
    expect(digest).toContain("### insiders.big-exec-buy (1)");
    expect(digest).toContain("…and 5 more (see signals table)");
  });

  it("shows tickers next to companies when present", () => {
    const digest = buildDigest([{ ...base, ticker: "BIG" }], {
      generatedAt: "2026-07-19",
      freshness: [],
    });
    expect(digest).toContain("**BIGCO [BIG]**");
  });

  it("omits the company slot entirely for subject-less signals", () => {
    const digest = buildDigest(
      [{ ...base, company: null, ticker: null, rule: "meta.source-stale", evidence: '{"a":1}' }],
      meta,
    );
    expect(digest).not.toContain("**?**");
    expect(digest).toContain('- [sev 2] {"a":1}');
  });

  it("surfaces how stale each item is", () => {
    const digest = buildDigest([base], { generatedAt: "2026-07-24", freshness: [] });
    expect(digest).toContain("23d old");
  });

  it("never renders undefined or NaN for missing or malformed evidence", () => {
    const broken = [
      { ...base, id: 1, rule: "contracts.mega-award", evidence: "{}" },
      { ...base, id: 2, rule: "contracts.mega-award", evidence: JSON.stringify({ amount: "lots" }) },
      { ...base, id: 3, rule: "contracts.new-large-recipient", evidence: JSON.stringify({ firstSeen: null }) },
      { ...base, id: 4, rule: "insiders.big-exec-buy", evidence: JSON.stringify({ date: "" }) },
      { ...base, id: 5, rule: "future.rule", evidence: "{}" },
      { ...base, id: 6, rule: "meta.source-stale", evidence: "not-json", company: null },
    ];
    const digest = buildDigest(broken, { generatedAt: "2026-07-20", freshness: [] });
    expect(digest).not.toContain("undefined");
    expect(digest).not.toContain("NaN");
    expect(digest).not.toContain("Invalid Date");
    // Every signal still appears — malformed evidence demotes the line, never drops it.
    expect(digest.split("\n").filter((line) => line.startsWith("- [sev "))).toHaveLength(6);
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
