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

## 5. Daily price history — Yahoo Finance chart API

Verified against live responses on 2026-07-22 (AAPL, LEU, AGX, SRFM, BRK-B).

- **Base URL:** `https://query1.finance.yahoo.com/v8/finance/chart`
  (`query2.` is an equivalent alias — same payload, useful if one host misbehaves).
- **Endpoint:** `GET /v8/finance/chart/{SYMBOL}?range={range}&interval=1d`.
  Ranges used here: `1y` on first sight of a ticker, `1mo` for daily incremental runs.
  Valid ranges: `1d,5d,1mo,3mo,6mo,1y,2y,5y,10y,ytd,max`.
- **Auth:** none — no API key, no login, no crumb/cookie for *this* endpoint
  (unlike `/v7/finance/download`, which was retired, and the `quoteSummary` endpoints,
  which do require a crumb).
- **⚠ User-Agent is mandatory.** A bare client (curl/undici default) gets
  `429 "Edge: Too Many Requests"` from the CDN *regardless of request volume* — this is
  bot detection, not throttling. Send a normal browser UA and it returns 200 immediately.
- **Rate limits:** none documented. 12 back-to-back requests with no delay all returned
  200 in testing; we still space requests ~250 ms. Treat a 429 as per-ticker and skip,
  since it may be transient edge throttling.
- **Run sizing:** one request per ticker per day. The candidate set is signal tickers
  plus congress/insider names traded in the last 90 days — measured 2026-07-22 that is
  ~453 tickers (38 of them from `signals`), so ~3-5 min per daily run. A 400-ticker cap
  bounds the worst case; overflow rotates (never-priced and stalest first) so no ticker
  starves, and signal tickers always outrank trade tickers.
- **Response shape:** `chart.result[0]` with
  `meta` (`currency`, `gmtoffset`, `exchangeTimezoneName`, `regularMarketTime`,
  `currentTradingPeriod.regular.{start,end}`), a parallel `timestamp[]` array, and
  `indicators.quote[0].{open,high,low,close,volume}[]` plus
  `indicators.adjclose[0].adjclose[]`. Errors come back as
  `{"chart":{"result":null,"error":{"code":"Not Found","description":"No data found, symbol may be delisted"}}}`
  with HTTP **404** — clean to detect per ticker.
- **Freshness:** intraday. The last bar is the *current* session and updates tick by tick.
- **Gotchas:**
  - **The final bar is live, not settled.** Mid-session its `close` is the last trade and
    it changes between calls (observed 323.78 → 323.86 seconds apart). Because we dedupe
    with `INSERT OR IGNORE`, writing it would freeze a mid-session quote as that day's
    close permanently. The fetcher drops any bar belonging to the in-progress session
    (`regularMarketTime < currentTradingPeriod.regular.end`) and picks it up settled the
    next run. So the newest stored date is normally *yesterday* during market hours.
  - **Timestamps are session-open instants in UTC** (13:30Z = 09:30 ET), not midnight.
    Convert with `meta.gmtoffset` to get the exchange-local trading date; a naive UTC
    date happens to agree for US equities but breaks for other venues.
  - **Share classes use a dash**, e.g. `BRK-B`. `BRK.B` returns 404. This matches SEC's
    `company_tickers.json` spelling, but congressional filings sometimes use dots, so
    the fetcher folds `.` → `-`.
  - `close` entries can be `null` on halted/padded days — drop those bars, never
    carry a price forward.
  - Unofficial/undocumented API: it has been stable for years and is what most
    open-source finance libraries use, but there is no contract. If it dies, the
    fallback is Stooq (below) or an API-keyed source such as Alpha Vantage/Tiingo.
- **Licensing:** undocumented endpoint backing a public site; Yahoo's ToS permit personal,
  non-commercial use, and quotes are attributed to Yahoo Finance. Fine for personal
  research at this volume. Revisit — and move to a licensed feed — before any
  redistribution or commercial use.

### Rejected alternative: Stooq CSV

`https://stooq.com/q/d/l/?s=aapl.us&i=d` was the first choice (documented as a plain
unauthenticated CSV of daily OHLC). **As of 2026-07-22 it is unusable from a script:**
both `stooq.com` and `stooq.pl` now answer with an HTML interstitial that runs a
SHA-256 proof-of-work in JavaScript and posts to `/__verify` before serving data
(`"This site requires JavaScript to verify your browser"`). A browser User-Agent,
`Accept: text/csv`, and a matching `Referer` all still hit the wall — solving it would
mean running the PoW challenge, which is bot-detection circumvention. Re-check
periodically; if the wall comes down, Stooq is a good failover since it needs no UA
spoofing.
