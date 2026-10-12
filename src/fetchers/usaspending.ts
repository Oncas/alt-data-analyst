import { getWatermark, setWatermark } from "../db/index.js";
import type { Fetcher, FetcherContext, FetchResult } from "./index.js";

// See docs/SOURCES.md §1. Transaction-level search: each row is a contract action
// with an Action Date. Sorted by amount descending so we can stop paging as soon
// as rows fall below MIN_CONTRACT_USD instead of walking the long tail.
const ENDPOINT = "https://api.usaspending.gov/api/v2/search/spending_by_transaction/";

// Exact names from the endpoint's valid-values list (probed 2026-07-19).
const FIELDS = [
  "internal_id",
  "Award ID",
  "Mod",
  "Recipient Name",
  "Transaction Amount",
  "Action Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "naics_code",
  "product_or_service_code",
  "Transaction Description",
] as const;

const PAGE_LIMIT = 100;
const MAX_PAGES = 50;
/** FPDS reporting lag: agencies post actions late, so re-scan a window behind the watermark. */
const OVERLAP_DAYS = 7;
const DEFAULT_BACKFILL_DAYS = 30;

export interface UsaspendingRow {
  internal_id?: number | string;
  "Award ID"?: string;
  Mod?: string | number;
  "Recipient Name"?: string;
  "Transaction Amount"?: number | string;
  "Action Date"?: string;
  "Awarding Agency"?: string;
  "Awarding Sub Agency"?: string;
  naics_code?: string;
  product_or_service_code?: string;
  "Transaction Description"?: string;
}

export interface ContractRow {
  naturalKey: string;
  awardId: string;
  recipient: string;
  amount: number | null;
  actionDate: string;
  awardingAgency: string | null;
  awardingSubAgency: string | null;
  naics: string | null;
  psc: string | null;
  description: string | null;
  lastModified: string | null;
}

export function buildRequestBody(startDate: string, endDate: string, page: number) {
  return {
    filters: {
      time_period: [{ start_date: startDate, end_date: endDate, date_type: "action_date" }],
      award_type_codes: ["A", "B", "C", "D"],
    },
    fields: [...FIELDS],
    sort: "Transaction Amount",
    order: "desc",
    limit: PAGE_LIMIT,
    page,
  };
}

export function mapRow(raw: UsaspendingRow): ContractRow | null {
  const awardId = raw["Award ID"]?.trim();
  const recipient = raw["Recipient Name"]?.trim();
  const actionDate = raw["Action Date"];
  if (!awardId || !recipient || !actionDate) return null;

  const amountRaw = raw["Transaction Amount"];
  const amount =
    amountRaw === undefined || amountRaw === null ? null : Number(amountRaw);

  return {
    naturalKey:
      raw.internal_id !== undefined
        ? `usa:${raw.internal_id}`
        : `usa:${awardId}|${raw.Mod ?? ""}|${actionDate}|${amount ?? ""}`,
    awardId,
    recipient,
    amount: amount !== null && Number.isFinite(amount) ? amount : null,
    actionDate,
    awardingAgency: raw["Awarding Agency"] ?? null,
    awardingSubAgency: raw["Awarding Sub Agency"] ?? null,
    naics: raw.naics_code ?? null,
    psc: raw.product_or_service_code ?? null,
    description: raw["Transaction Description"] ?? null,
    lastModified: null,
  };
}

function isoDaysAgo(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

interface PageResponse {
  results: UsaspendingRow[];
  page_metadata?: { hasNext?: boolean };
}

async function fetchPage(startDate: string, endDate: string, page: number): Promise<PageResponse> {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildRequestBody(startDate, endDate, page)),
  });
  if (!response.ok) {
    throw new Error(`USAspending ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as PageResponse;
}

async function fetchContracts(ctx: FetcherContext): Promise<FetchResult> {
  const { db, config } = ctx;
  const watermark = getWatermark(db, "usaspending");
  const startDate = watermark
    ? new Date(new Date(watermark).getTime() - OVERLAP_DAYS * 86_400_000)
        .toISOString()
        .slice(0, 10)
    : isoDaysAgo(DEFAULT_BACKFILL_DAYS);
  const endDate = new Date().toISOString().slice(0, 10);

  const insert = db.prepare(
    `INSERT OR IGNORE INTO contracts
       (natural_key, award_id, recipient, amount, action_date, awarding_agency,
        awarding_sub_agency, naics, psc, description, last_modified)
     VALUES (@naturalKey, @awardId, @recipient, @amount, @actionDate, @awardingAgency,
             @awardingSubAgency, @naics, @psc, @description, @lastModified)`,
  );

  let inserted = 0;
  let skipped = 0;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = await fetchPage(startDate, endDate, page);
    let belowThreshold = false;

    const insertAll = db.transaction((rows: UsaspendingRow[]) => {
      for (const raw of rows) {
        const row = mapRow(raw);
        if (!row) {
          skipped++;
          continue;
        }
        if (row.amount !== null && row.amount < config.MIN_CONTRACT_USD) {
          belowThreshold = true;
          continue;
        }
        if (insert.run(row).changes > 0) inserted++;
        else skipped++;
      }
    });
    insertAll(data.results);

    // Amount-descending sort: once a page dips below the threshold, the rest of
    // the result set is smaller still.
    if (belowThreshold || !data.page_metadata?.hasNext) break;
  }

  setWatermark(db, "usaspending", endDate);
  return { inserted, skipped };
}

export const usaspendingFetcher: Fetcher = {
  name: "usaspending",
  fetch: fetchContracts,
};
