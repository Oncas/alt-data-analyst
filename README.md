# alt-data-analyst

Personal alternative-data research pipeline. Pulls free public government datasets
(federal contract awards, lobbying disclosures, insider trades, 13F holdings,
congressional stock trades) into a local SQLite database, runs screening rules to
flag notable activity, and feeds a weekly research report.

> Reports are informational analysis of public data — not investment advice.

## Architecture

```
                 ┌─────────────┐
  USAspending ──►│             │
  Senate LDA  ──►│  fetchers   │──► SQLite (data/altdata.sqlite)
  SEC EDGAR   ──►│  (src/      │          │
  Congress    ──►│  fetchers/) │          ▼
                 └─────────────┘   screening rules (src/screen/)
                                          │
                                          ▼
                                   flagged signals table
                                          │
                                          ▼
                                 weekly research report
                              (scheduled weekly + on-demand)
```

## Stack

- Node 22+ / TypeScript, run with `tsx`
- `better-sqlite3` for storage
- No framework — plain fetch + a small CLI

## CLI (planned)

```
npm run fetch          # incremental pull from all sources
npm run fetch -- lda   # single source
npm run screen         # run screening rules over new data
npm run report         # print flagged signals + context for report writing
```

## Setup

```
npm install
copy .env.example .env   # then fill in values (see comments in the file)
npm run fetch
```

## Docs

- [Data sources](docs/SOURCES.md) — endpoints, auth, rate limits, gotchas
