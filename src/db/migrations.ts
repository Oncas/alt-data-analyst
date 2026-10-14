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
  {
    id: 4,
    sql: `
      CREATE TABLE insider_trades (
        id INTEGER PRIMARY KEY,
        accession TEXT NOT NULL,
        txn_index INTEGER NOT NULL,
        ticker TEXT,
        issuer_name TEXT,
        issuer_cik TEXT,
        insider_name TEXT,
        insider_role TEXT,
        transaction_code TEXT NOT NULL,
        transaction_date TEXT,
        shares REAL,
        price REAL,
        value REAL,
        acquired_disposed TEXT,
        filed_at TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (accession, txn_index)
      );

      CREATE INDEX idx_insider_ticker ON insider_trades (ticker);
      CREATE INDEX idx_insider_txn_date ON insider_trades (transaction_date);
    `,
  },
  {
    id: 5,
    sql: `
      CREATE TABLE congress_trades (
        id INTEGER PRIMARY KEY,
        source_id TEXT NOT NULL UNIQUE,
        filer_name TEXT NOT NULL,
        chamber TEXT,
        party TEXT,
        state TEXT,
        office TEXT,
        owner TEXT,
        ticker TEXT,
        asset_name TEXT,
        asset_type TEXT,
        transaction_type TEXT,
        transaction_date TEXT,
        filing_date TEXT,
        amount_low REAL,
        amount_high REAL,
        amount_label TEXT,
        days_to_file INTEGER,
        is_late INTEGER,
        doc_url TEXT,
        fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
      );

      CREATE INDEX idx_congress_ticker ON congress_trades (ticker);
      CREATE INDEX idx_congress_txn_date ON congress_trades (transaction_date);
      CREATE INDEX idx_congress_filer ON congress_trades (filer_name);
    `,
  },
];
