import { getWatermark, setWatermark } from "../db/index.js";
import { shiftDate, todayIso } from "../util/dates.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §2. lda.senate.gov sunsets 2026-07-31; lda.gov is the
// successor with an identical API surface but sits behind Akamai that 403s
// bare clients — hence the browser-ish User-Agent and the fallback order.
const BASE_URLS = ["https://lda.gov/api/v1", "https://lda.senate.gov/api/v1"];

const PAGE_SIZE = 25; // API cap
const DEFAULT_BACKFILL_DAYS = 14;
// Anonymous limit is 15 req/min; a registered key allows 120 req/min.
const MAX_PAGES_ANON = 10;
const MAX_PAGES_KEYED = 60;
const PAGE_DELAY_MS_ANON = 4_100;
const PAGE_DELAY_MS_KEYED = 600;

export interface LdaFilingRaw {
  filing_uuid?: string;
  filing_type?: string;
  filing_year?: number;
  filing_period?: string;
  income?: string | null;
  expenses?: string | null;
  dt_posted?: string;
  registrant?: { name?: string } | null;
  client?: { name?: string; general_description?: string | null } | null;
  lobbying_activities?: { general_issue_code?: string }[];
  filing_document_url?: string | null;
}

export interface LobbyingFilingRow {
  filingUuid: string;
  filingType: string | null;
  filingYear: number | null;
  filingPeriod: string | null;
  income: number | null;
  expenses: number | null;
  dtPosted: string;
  registrant: string | null;
  client: string | null;
  clientDescription: string | null;
  issueCodes: string; // JSON array
  documentUrl: string | null;
}

function toAmount(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

export function mapFiling(raw: LdaFilingRaw): LobbyingFilingRow | null {
  if (!raw.filing_uuid || !raw.dt_posted) return null;
  const issueCodes = [
    ...new Set(
      (raw.lobbying_activities ?? [])
        .map((activity) => activity.general_issue_code)
        .filter((code): code is string => Boolean(code)),
    ),
  ];
  return {
    filingUuid: raw.filing_uuid,
    filingType: raw.filing_type ?? null,
    filingYear: raw.filing_year ?? null,
    filingPeriod: raw.filing_period ?? null,
    income: toAmount(raw.income),
    expenses: toAmount(raw.expenses),
    dtPosted: raw.dt_posted,
    registrant: raw.registrant?.name ?? null,
    client: raw.client?.name ?? null,
    clientDescription: raw.client?.general_description ?? null,
    issueCodes: JSON.stringify(issueCodes),
    documentUrl: raw.filing_document_url ?? null,
  };
}

export function buildFilingsUrl(base: string, postedAfter: string): string {
  const url = new URL(`${base}/filings/`);
  url.searchParams.set("filing_dt_posted_after", postedAfter);
  url.searchParams.set("ordering", "dt_posted");
  url.searchParams.set("page_size", String(PAGE_SIZE));
  return url.toString();
}

interface FilingsPage {
  results: LdaFilingRaw[];
  next: string | null;
}

function requestHeaders(apiKey: string | undefined): Record<string, string> {
  const headers: Record<string, string> = {
    // Akamai on lda.gov rejects bare clients; identify as a regular browser UA.
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) alt-data-analyst personal research",
    Accept: "application/json",
  };
  if (apiKey) headers.Authorization = `Token ${apiKey}`;
  return headers;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function resolveBase(apiKey: string | undefined): Promise<string> {
  let lastError: Error | null = null;
  for (const base of BASE_URLS) {
    try {
      const probe = await fetch(buildFilingsUrl(base, todayIso()), {
        headers: requestHeaders(apiKey),
      });
      if (probe.ok) return base;
      lastError = new Error(`${base} responded ${probe.status}`);
    } catch (error) {
      lastError = error as Error;
    }
  }
  throw new Error(`No LDA base URL reachable: ${lastError?.message}`);
}

async function fetchLobbying(ctx: FetcherContext): Promise<FetchResult> {
  const { db, config } = ctx;
  const apiKey = config.LDA_API_KEY;
  const postedAfter =
    getWatermark(db, "lda") ?? shiftDate(todayIso(), -DEFAULT_BACKFILL_DAYS);

  const base = await resolveBase(apiKey);
  const maxPages = apiKey ? MAX_PAGES_KEYED : MAX_PAGES_ANON;
  const pageDelay = apiKey ? PAGE_DELAY_MS_KEYED : PAGE_DELAY_MS_ANON;

  const insert = db.prepare(
    `INSERT OR IGNORE INTO lobbying_filings
       (filing_uuid, filing_type, filing_year, filing_period, income, expenses,
        dt_posted, registrant, client, client_description, issue_codes, document_url)
     VALUES (@filingUuid, @filingType, @filingYear, @filingPeriod, @income, @expenses,
             @dtPosted, @registrant, @client, @clientDescription, @issueCodes, @documentUrl)`,
  );

  let inserted = 0;
  let skipped = 0;
  let url: string | null = buildFilingsUrl(base, postedAfter);

  for (let page = 1; page <= maxPages && url; page++) {
    const response = await fetch(url, { headers: requestHeaders(apiKey) });
    if (response.status === 429) {
      // Throttled: keep the progress made so far; the next run resumes from
      // the advanced watermark.
      console.error(`lda: throttled at page ${page}; resuming next run`);
      break;
    }
    if (!response.ok) {
      throw new Error(`LDA ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const data = (await response.json()) as FilingsPage;

    let lastDtPosted: string | null = null;
    const insertPage = db.transaction((rows: LdaFilingRaw[]) => {
      for (const raw of rows) {
        const row = mapFiling(raw);
        if (!row) {
          skipped++;
          continue;
        }
        if (insert.run(row).changes > 0) inserted++;
        else skipped++;
        lastDtPosted = row.dtPosted;
      }
    });
    insertPage(data.results);

    // Ascending dt_posted ordering makes "last row seen" a safe resume point
    // even when a run stops early (throttle or page cap).
    if (lastDtPosted) setWatermark(db, "lda", lastDtPosted);

    url = data.next;
    if (url) await sleep(pageDelay);
  }

  return { inserted, skipped };
}

export const ldaFetcher: Fetcher = {
  name: "lda",
  fetch: fetchLobbying,
};
