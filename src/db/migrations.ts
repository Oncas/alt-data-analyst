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
  {
    id: 2,
    sql: `
      CREATE TABLE contracts (
        id INTEGER PRIMARY KEY,
        natural_key TEXT NOT NULL UNIQUE,
        award_id TEXT NOT NULL,
        recipient TEXT NOT NULL,
        amount REAL,
        action_date TEXT NOT NULL,
        awarding_agency TEXT,
        awarding_sub_agency TEXT,
        naics TEXT,
        psc TEXT,
        description TEXT,
        last_modified TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_contracts_action_date ON contracts (action_date);
      CREATE INDEX idx_contracts_recipient ON contracts (recipient);
    `,
  },
  {
    id: 3,
    sql: `
      CREATE TABLE lobbying_filings (
        id INTEGER PRIMARY KEY,
        filing_uuid TEXT NOT NULL UNIQUE,
        filing_type TEXT,
        filing_year INTEGER,
        filing_period TEXT,
        income REAL,
        expenses REAL,
        dt_posted TEXT NOT NULL,
        registrant TEXT,
        client TEXT,
        client_description TEXT,
        issue_codes TEXT NOT NULL DEFAULT '[]',
        document_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_lobbying_client ON lobbying_filings (client);
      CREATE INDEX idx_lobbying_dt_posted ON lobbying_filings (dt_posted);
    `,
  },
];
