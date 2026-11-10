# Decisions

Design choices that had more than one reasonable answer, with what was chosen
and why. Code comments refer to them by number (D1-D7).

## Open

**D7. 13F put/call direction.** `mapInfoTable` (`src/fetchers/edgar13f.ts`)
reads `value` and `shrsOrPrnAmt` from each holding but not `putCall`, so a
bearish options position is stored and screened the same way as a stock
purchase. Example: the 13F signal for Scion Asset Management and Palantir
($912.1M, period 2025-09-30) was a put position, publicly reported in
November 2025, the opposite of what "new position" suggests.

- **A (planned):** add a `put_call` column, parse
  `entry.shrsOrPrnAmt?.putCall ?? entry.putCall`, and exclude or separately
  flag put rows in both 13F rules.
- **B:** remove options-heavy funds from `config/funds.json` and accept the
  gap for the rest.

Until A lands, treat the direction of any 13F signal as unverified.

## Resolved

- **D1. Scan scope:** a broad scan with strict thresholds. A boosted watchlist
  remains a small config change if it's ever wanted.
- **D2. Minimum contract size:** $5M (`MIN_CONTRACT_USD` in `.env`, no code
  change needed). Worth revisiting after a few weekly reports show the real
  signal volume; $1M is the likely alternative.
- **D3. Congressional backfill:** full history from 2012, imported from the
  kadoa dataset.
- **D4. Report cadence:** a weekly report, plus a weekday quiet scan that runs
  fetch and screen and only alerts on notable signals (severity 3 or
  cross-source). The quiet scan never marks signals as reported, so they stay
  for the weekly issue. Congressional disclosures arrive about 62 days late,
  so speed doesn't help there, but insider Form 4 filings are at most 2 days
  old; the quiet scan exists mainly for those.
- **D5. 13F watchlist:** Berkshire, Pershing Square, Appaloosa, Baupost,
  Scion, Duquesne, Third Point, Greenlight, Coatue and Altimeter. Editable in
  `config/funds.json`.
- **D6. Name matching:** conservative. Normalized exact match plus
  `config/ticker-overrides.json`; no fuzzy matching.
