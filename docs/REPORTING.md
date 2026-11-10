# Writing a report

The pipeline produces a digest; a person writes the weekly report from it.
These are the rules each issue follows.

## Steps

1. Run `npm run fetch`, then `npm run screen`.
2. Run `npm run report -- preview` and read the digest of new signals.
3. Write the report. Explain why each item is unusual, using the evidence on
   its line, and add public context where it helps. Save a copy under
   `reports/` (gitignored).
4. Only after the report is finished, run `npm run report` to mark those
   signals as reported. A failed write-up never loses signals.

For anything the digest doesn't show, query the database directly:
`npx tsx scripts/peek.ts "<SELECT ...>"`.

## What to lead with

The digest is grouped into usefulness tiers (`src/report/tiers.ts`) and is
already in the order the report should follow. Don't re-sort it by dollar
size: that is what made the first report lead with its weakest item.

- **Lead with cross-source signals** (the `Lead` tier). A company flagged
  independently by two unrelated sources is the one thing this pipeline finds
  that a news feed can't. Never open a report with a contract award, however
  large.
- **Contract and lobbying items confirm; they don't discover.** That data is
  about 23 days old when it arrives. Before featuring one, check whether the
  company already announced it (press release or 8-K). If it did, say so -
  "announced by the company on <date>; this confirms it" - and move it down.
  The first report's lead was a $900M DOE award that had been public for six
  months.
- **Prefer items that map to a listed company.** Cross-source, insider and
  congressional signals almost always do; contract and lobbying rules only
  7-26% of the time. When an item is a private company, a subsidiary or a
  joint venture, say so in the same sentence (for example "TriWest -
  private").
- **Read the pipeline-health block first.** If a source is stale, the absence
  of signals from it proves nothing, and the report must say so.
- **Check signal age.** Each line shows it ("23d old"). Anything months old is
  background, not the story.

## End with a scored watch list

Close each issue with 3-5 named items, each with an outcome that can be
checked and a date, so the next issue can grade them:

- Good: "Centrus (LEU) books at least $50M HALEU revenue in the Q3 report
  (due around Nov 4)."
- Bad: "Watch the nuclear fuel theme."

Open each issue by grading the previous list as hit, miss or unresolved,
including the misses. For now the previous list is read from the last file in
`reports/`.

Reports are informational analysis of public data, not investment advice.
