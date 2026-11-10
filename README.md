# alt-data-analyst

A personal research pipeline for public alternative data. It pulls free
government datasets into a local SQLite database, screens them for unusual
activity, and prints a digest of flagged signals that a weekly written report
is built from.

Reports are informational analysis of public data, not investment advice.

## How it works

```
USAspending ----+
LDA lobbying ---+
EDGAR Form 4 ---+
EDGAR 13F ------+--> fetch --> SQLite --> screen --> ticker   --> report
Congress -------+                         (rules)    matching     (digest)
SEC tickers ----+
Yahoo prices ---+
```

1. `fetch` pulls each source incrementally from a stored watermark, so re-runs
   are cheap and never duplicate rows.
2. `screen` runs 15 rules and stores each hit once as a signal, then matches
   company names to tickers.
3. `report` prints unreported signals as a markdown digest, in this order:
   pipeline health, cross-source signals, single-source finds, then
   confirmations of news that is already public.

The most useful output is the cross-source signal: one company flagged
independently by two unrelated sources, such as an insider buy at a company
that just won a large contract.

## Sources

| Source | What it gives | Delay |
|---|---|---|
| USAspending | Federal contract awards above `MIN_CONTRACT_USD` | Days to weeks, DoD up to ~90 days |
| LDA (lda.gov) | Lobbying registrations and quarterly spend | Quarterly filings |
| EDGAR Form 4 | Insider open-market buys and sells | ~2 business days |
| EDGAR 13F | Holdings of the 10 funds in `config/funds.json` | 45-90 days |
| Congress trades | House and Senate member trades, full history | Up to 45 days |
| SEC company tickers | Name-to-ticker lookup, refreshed weekly | - |
| Yahoo Finance | Daily prices for flagged and recently traded tickers | 1 day |

Contract and lobbying signals usually arrive weeks after the news, so they
mostly confirm a story rather than break it. Endpoints, limits and quirks for
each source are in [docs/SOURCES.md](docs/SOURCES.md).

## Setup

Requires Node.js 22 or newer (last tested on 26).

```
npm install
cp .env.example .env
```

Then fill in `.env`:

| Setting | Default | Purpose |
|---|---|---|
| `SEC_USER_AGENT` | (required) | SEC requires a User-Agent with your name and a contact email. The Form 4, 13F and ticker fetches fail without it. |
| `LDA_API_KEY` | none | Raises the LDA limit from 15 to 120 requests a minute. Free at https://lda.gov/api/register/ |
| `DB_PATH` | `data/altdata.sqlite` | Database file |
| `MIN_CONTRACT_USD` | `5000000` | Smallest contract award fetched |
| `MEGA_CONTRACT_USD` | `250000000` | Threshold for the mega-award rule |
| `LOBBY_MIN_USD` | `250000` | Spend floor for the watched-issue rule |
| `INSIDER_BIG_BUY_USD` | `250000` | Floor for the big-exec-buy rule |
| `WATCH_ISSUE_CODES` | `DEF,HOM,ENG,PHA,CPI` | LDA issue codes the watched-issue rule tracks |

The first `npm run fetch` backfills the full congressional trade history,
which takes noticeably longer than later runs.

## Commands

```
npm run fetch                # pull new data from every source
npm run fetch -- <source>    # one source: usaspending, lda, edgar-form4,
                             #   congress, tickers, edgar-13f, prices
npm run screen               # run the rules and match names to tickers
npm run report -- preview    # print the digest without consuming signals
npm run report               # print the digest and mark its signals reported
npm run ticker -- <SYMBOL>   # everything stored about one ticker
npm test                     # unit tests (vitest)
npm run typecheck            # type check only, nothing is emitted
npx tsx scripts/peek.ts "<SELECT ...>"   # ad-hoc query against the database
```

A failing source doesn't stop the others; `fetch` exits non-zero if any of
them failed.

## Weekly report

Each issue is written from `npm run report -- preview`, and the signals are
consumed with `npm run report` only once the write-up is done, so a failed
write-up never loses them. The writing rules are in [docs/REPORTING.md](docs/REPORTING.md):
never lead with a contract award, say when a find was already public or the
company can't be traded, and end each issue with a dated watch list that the
next issue grades. Finished reports are saved under `reports/`, which is
gitignored.

Nothing schedules the run by itself; use cron or any other scheduler to run
fetch, screen and report.

## Status

All seven sources, the screening rules, ticker matching, the digest and the
per-ticker view work, with 165 passing tests. Known gaps:

- 13F rows ignore put/call, so a large put position is screened as if it were
  a new long position.
- Rule thresholds still need tuning against a few real weekly digests.

## Docs

- [docs/SOURCES.md](docs/SOURCES.md) - endpoints, auth, rate limits and quirks
- [docs/REPORTING.md](docs/REPORTING.md) - how a weekly report is written
- [docs/DECISIONS.md](docs/DECISIONS.md) - design decisions, open and resolved
