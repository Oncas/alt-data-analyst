import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { migrations } from "./migrations.js";

export type Db = Database.Database;

export function openDb(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  return db;
}

export function migrate(db: Db): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS schema_migrations (
       id INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
  const applied = new Set(
    db
      .prepare("SELECT id FROM schema_migrations")
      .all()
      .map((row) => (row as { id: number }).id),
  );
  const apply = db.transaction((id: number, sql: string) => {
    db.exec(sql);
    db.prepare("INSERT INTO schema_migrations (id) VALUES (?)").run(id);
  });
  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      apply(migration.id, migration.sql);
    }
  }
}

export function getWatermark(db: Db, source: string): string | undefined {
  const row = db
    .prepare("SELECT watermark FROM fetch_state WHERE source = ?")
    .get(source) as { watermark: string | null } | undefined;
  return row?.watermark ?? undefined;
}

export function setWatermark(db: Db, source: string, watermark: string): void {
  db.prepare(
    `INSERT INTO fetch_state (source, watermark, last_run_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT (source) DO UPDATE SET
       watermark = excluded.watermark,
       last_run_at = excluded.last_run_at`,
  ).run(source, watermark);
}

export interface SignalInput {
  source: string;
  rule: string;
  dedupeKey: string;
  company?: string;
  ticker?: string;
  severity?: number;
  evidence?: Record<string, unknown>;
}

/** Insert a signal; returns false if this (rule, dedupeKey) was already flagged. */
export function insertSignal(db: Db, signal: SignalInput): boolean {
  const result = db
    .prepare(
      `INSERT OR IGNORE INTO signals
         (source, rule, dedupe_key, company, ticker, severity, evidence)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      signal.source,
      signal.rule,
      signal.dedupeKey,
      signal.company ?? null,
      signal.ticker ?? null,
      signal.severity ?? 1,
      JSON.stringify(signal.evidence ?? {}),
    );
  return result.changes > 0;
}
