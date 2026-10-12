import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  getWatermark,
  insertSignal,
  migrate,
  setWatermark,
  type Db,
} from "../src/db/index.js";
import { migrations } from "../src/db/migrations.js";

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

describe("migrations", () => {
  it("creates the core tables", () => {
    const db = memoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => (row as { name: string }).name);
    expect(tables).toContain("fetch_state");
    expect(tables).toContain("signals");
  });

  it("is idempotent", () => {
    const db = memoryDb();
    expect(() => migrate(db)).not.toThrow();
    const applied = db
      .prepare("SELECT COUNT(*) AS n FROM schema_migrations")
      .get() as { n: number };
    expect(applied.n).toBe(migrations.length);
  });
});

describe("watermarks", () => {
  it("round-trips and overwrites", () => {
    const db = memoryDb();
    expect(getWatermark(db, "usaspending")).toBeUndefined();
    setWatermark(db, "usaspending", "2026-07-01");
    expect(getWatermark(db, "usaspending")).toBe("2026-07-01");
    setWatermark(db, "usaspending", "2026-07-15");
    expect(getWatermark(db, "usaspending")).toBe("2026-07-15");
  });
});

describe("signals", () => {
  it("inserts and deduplicates on (rule, dedupe_key)", () => {
    const db = memoryDb();
    const signal = {
      source: "usaspending",
      rule: "contracts.new-large-award",
      dedupeKey: "AWARD123",
      company: "Acme Corp",
      severity: 2,
      evidence: { amount: 12_000_000 },
    };
    expect(insertSignal(db, signal)).toBe(true);
    expect(insertSignal(db, signal)).toBe(false);
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM signals")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });

  it("stores evidence as JSON", () => {
    const db = memoryDb();
    insertSignal(db, {
      source: "lda",
      rule: "lobbying.spend-spike",
      dedupeKey: "acme-2026Q2",
      evidence: { quarter: "2026Q2", ratio: 3.2 },
    });
    const row = db
      .prepare("SELECT evidence FROM signals")
      .get() as { evidence: string };
    expect(JSON.parse(row.evidence)).toEqual({ quarter: "2026Q2", ratio: 3.2 });
  });
});
