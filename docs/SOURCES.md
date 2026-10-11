# Data Sources

Verified against official docs and live responses on 2026-07-19. Re-verify anything here
before relying on it after ~2026-Q4.

## 1. USAspending.gov — federal contract awards

- **Endpoint:** `POST https://api.usaspending.gov/api/v2/search/spending_by_transaction/`
  (each row is a transaction with an Action Date — the right shape for a "new awards" feed).
  Award-level companion: `POST /api/v2/search/spending_by_award/`.
- **Auth / limits:** none, no documented rate limit. Data refreshed nightly
  (`GET /api/v2/awards/last_updated/` to check).
- **Request shape:** everything is POST + JSON body. Required:
  `filters.award_type_codes: ["A","B","C","D"]` (contracts). Date filter:
  `filters.time_period: [{start_date, end_date, date_type: "action_date"}]`.
  You must list every wanted column in `fields` (exact display names):
  `"Award ID", "Recipient Name", "Transaction Amount", "Action Date", "Awarding Agency",
  "Awarding Sub Agency", "NAICS", "PSC", "Description", "Last Modified Date"`.
  Sort: `sort: "Action Date", order: "desc"` (default sort is Transaction Amount — wrong for us).
- **Pagination:** `page` + `limit` in body; `page_metadata.hasNext`; for deep paging use
  keyset params `last_record_unique_id` + `last_record_sort_value`.
- **Gotchas:** upstream FPDS lag — agencies can report actions days late (DoD historically
  up to ~90 days), so fetch with an overlap window behind the watermark, not from it exactly.

## 2. Lobbying — LDA filings API

- **⚠ MIGRATION:** `lda.senate.gov/api/v1/` sunsets **2026-07-31** (live responses already
  send `sunset` headers). Build against the successor **`https://lda.gov/api/v1/`**.
  Note: lda.gov serves Akamai 403 to bare non-browser clients — send a normal browser-ish
  User-Agent and the auth token.
- **Endpoint:** `GET /api/v1/filings/`. Also `/contributions/`, `/registrants/`, `/clients/`,
  and `/constants/filing/lobbyingactivityissues/` (issue-code lookup).
- **Auth:** anonymous = 15 req/min. Free key (register at `/api/register/`) = 120 req/min,
  header `Authorization: Token <key>`. 429 + `Retry-After` when throttled.
- **Incremental poll:** `?filing_dt_posted_after=<watermark>&ordering=dt_posted`.
  Pagination: `?page=N&page_size=25` (25 is the cap), envelope `{count, next, results}`.
- **Key fields:** `filing_uuid` (dedupe key), `filing_type`, `filing_year`, `filing_period`,
  `income`, `expenses`, `dt_posted`, `registrant.name`, `client.name`,
  `lobbying_activities[].general_issue_code`, `.description`.
- **Gotchas:** `income` (outside firms) vs `expenses` (in-house) are mutually exclusive;
  registrations (`RR`) have both null. Amounts are strings or null.

## 3. SEC EDGAR — Form 4 insider trades + 13F holdings

- **Policy (all sec.gov hosts):** max 10 req/s (we throttle to 5), and a declared
  User-Agent is REQUIRED, format `Name email@example.com` — anonymous gets 403.
  No API keys.
- **Form 4, near-real-time (primary):** EFTS full-text search —
  `GET https://efts.sec.gov/LATEST/search-index?forms=4&dateRange=custom&startdt=...&enddt=...`.
  Hits carry `adsh` (accession), `ciks`, `display_names` (insider + issuer), `file_date`;
  `_id` = `accession:filename.xml` → fetch the Form 4 XML at
  `/Archives/edgar/data/{cik}/{adsh-no-dashes}/{filename}`. Paginate with `&from=`,
  capped ~10k results — slice by date to stay under.
- **Form 4 fallback:** daily index `https://www.sec.gov/Archives/edgar/daily-index/{YYYY}/QTR{n}/form.{YYYYMMDD}.idx`
  (built each business-day evening). Full index rebuilt Saturdays — that's when
  post-acceptance deletions appear, so stored rows can retroactively vanish upstream.
- **Form 4 backfill:** quarterly "Insider Transactions Data Sets" ZIPs on sec.gov
  (structured tables, 2006 → last full quarter).
- **13F:** discover 13F-HR filings via EFTS/daily index; each filing has a structured XML
  info table in its Archives folder. Quarterly structured data sets also published.
  Freshness is inherently ~45-90 days (45-day filing deadline).

## 4. Congressional stock trades

- **Primary: kadoa-org/congress-trading-monitor** (GitHub, MIT, refreshed daily —
  verified current same-day):
  `https://raw.githubusercontent.com/kadoa-org/congress-trading-monitor/main/public/data/trades.json`
  (~4.3 MB, 54k+ transactions 2012→present, House + Senate + OGE). Fields:
  `id, source_id, transaction_date, filing_date, owner, ticker, asset_name, asset_type,
  transaction_type, amount_range_low/high/label, days_to_file, is_late, filer_id,
  filer_name, chamber, party, state, office, doc_url, filing_type`.
  No auth. Data is offered for research/educational use — fine for personal research;
  revisit licensing if this ever becomes commercial.
- **Fallback (official, House only):** House Clerk index
  `https://disclosures-clerk.house.gov/public_disc/financial-pdfs/{YYYY}FD.zip` →
  `{YYYY}FD.xml` (FilingType `P` = PTR) → PDFs at `/public_disc/ptr-pdfs/{YYYY}/{DocID}.pdf`.
  PTRs are PDFs (e-filed ones text-extractable). Send a browser-ish User-Agent.
- **Ruled out:** Senate eFD direct (Akamai bot-wall), Finnhub (premium-only endpoint),
  Lambda Finance (50 calls/mo free cap), House/Senate Stock Watcher (dead).
- **Risk:** kadoa is a third-party repo that could stop refreshing — the fetcher should
  alert (not fail silently) if the dataset's newest filing_date goes stale by >7 days.
