export interface Migration {
  id: number;
  sql: string;
}

export const migrations: Migration[] = [
  {
    id: 1,
    sql: `
      CREATE TABLE fetch_state (
        source TEXT PRIMARY KEY,
        watermark TEXT,
        last_run_at TEXT
      );

      CREATE TABLE signals (
        id INTEGER PRIMARY KEY,
        source TEXT NOT NULL,
        rule TEXT NOT NULL,
        dedupe_key TEXT NOT NULL,
        company TEXT,
        ticker TEXT,
        severity INTEGER NOT NULL DEFAULT 1,
        evidence TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        reported_at TEXT,
        UNIQUE (rule, dedupe_key)
      );

      CREATE INDEX idx_signals_reported ON signals (reported_at);
    `,
  },
];
