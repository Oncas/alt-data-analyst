import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  congressFetcher,
  isStale,
  mapTrade,
  normalizeTicker,
  type KadoaTradeRaw,
} from "../src/fetchers/congress.js";
import { todayIso } from "../src/util/dates.js";

const fixtureTrade: KadoaTradeRaw = {
  id: "h-12345",
  transaction_date: "2026-07-01",
  filing_date: todayIso(),
  owner: "SP",
  ticker: "nvda",
  asset_name: "NVIDIA Corp",
  asset_type: "stock",
  transaction_type: "Purchase",
  amount_range_low: 15001,
  amount_range_high: 50000,
  amount_range_label: "$15,001 - $50,000",
  days_to_file: 12,
  is_late: false,
  filer_name: "Jane Doe",
  chamber: "House",
  party: "D",
  state: "CA",
  office: "CA-12",
  doc_url: "https://disclosures-clerk.house.gov/x.pdf",
  filing_type: "P",
};

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeTicker", () => {
  it("uppercases and nulls placeholders", () => {
    expect(normalizeTicker("nvda")).toBe("NVDA");
    expect(normalizeTicker("--")).toBeNull();
    expect(normalizeTicker("N/A")).toBeNull();
    expect(normalizeTicker("")).toBeNull();
    expect(normalizeTicker(null)).toBeNull();
  });
});

describe("mapTrade", () => {
  it("maps a full record, lowercasing transaction type", () => {
    const row = mapTrade(fixtureTrade);
    expect(row).toMatchObject({
      sourceId: "h-12345",
      filerName: "Jane Doe",
      ticker: "NVDA",
      transactionType: "purchase",
      amountLow: 15001,
      isLate: 0,
    });
  });

  it("rejects records without id or filer", () => {
    expect(mapTrade({ ...fixtureTrade, id: undefined })).toBeNull();
    expect(mapTrade({ ...fixtureTrade, filer_name: undefined })).toBeNull();
  });

  it("fills filer identity from file-level defaults (backfill shape)", () => {
    const row = mapTrade(
      { ...fixtureTrade, filer_name: undefined, chamber: undefined, party: undefined },
      { filer_name: "Josh Gottheimer", chamber: "house", party: "D" },
    );
    expect(row).toMatchObject({ filerName: "Josh Gottheimer", chamber: "house", party: "D" });
  });
});

describe("isStale", () => {
  it("is stale when newest filing predates the threshold or is missing", () => {
    expect(isStale("2026-07-01", "2026-07-20")).toBe(true);
    expect(isStale(null, "2026-07-20")).toBe(true);
    expect(isStale("2026-07-18", "2026-07-20")).toBe(false);
  });
});

describe("congressFetcher.fetch", () => {
  const config = { DB_PATH: ":memory:" } as Config;

  /** Routes stubbed fetches by URL: filers list, one filer history, rolling feed. */
  function stubDataset(rolling: KadoaTradeRaw[], historyFilingDate: string = todayIso()) {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        const u = String(url);
        if (u.endsWith("/filers.json")) {
          return Promise.resolve(
            jsonResponse([
              { id: "house_jane_doe", full_name: "Jane Doe", chamber: "house", trade_count: 1 },
              { id: "house_empty", full_name: "No Trades", trade_count: 0 },
            ]),
          );
        }
        if (u.includes("/filer/house_jane_doe.json")) {
          return Promise.resolve(
            jsonResponse({
              trades: [
                {
                  ...fixtureTrade,
                  id: "hist-1",
                  filer_name: undefined,
                  filing_date: historyFilingDate,
                },
              ],
            }),
          );
        }
        return Promise.resolve(jsonResponse(rolling));
      }),
    );
  }

  it("backfills filer history once, then inserts the rolling feed with dedupe", async () => {
    const db = memoryDb();
    stubDataset([fixtureTrade, { ...fixtureTrade, id: "h-2" }]);

    const first = await congressFetcher.fetch({ db, config });
    expect(first).toEqual({ inserted: 3, skipped: 0 }); // 1 history + 2 rolling

    const historyRow = db
      .prepare("SELECT filer_name FROM congress_trades WHERE source_id = 'hist-1'")
      .get() as { filer_name: string };
    expect(historyRow.filer_name).toBe("Jane Doe");

    // Second run: backfill watermark set -> only the rolling feed, all deduped.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse([fixtureTrade, { ...fixtureTrade, id: "h-2" }]),
    );
    vi.stubGlobal("fetch", fetchMock);
    const second = await congressFetcher.fetch({ db, config });
    expect(second).toEqual({ inserted: 0, skipped: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const stale = db
      .prepare("SELECT COUNT(*) n FROM signals WHERE rule = 'meta.source-stale'")
      .get() as { n: number };
    expect(stale.n).toBe(0);
  });

  it("emits a digest alert when the dataset has gone stale", async () => {
    const db = memoryDb();
    stubDataset([{ ...fixtureTrade, filing_date: "2026-06-01" }], "2026-05-15");
    await congressFetcher.fetch({ db, config });
    const stale = db
      .prepare("SELECT COUNT(*) n FROM signals WHERE rule = 'meta.source-stale'")
      .get() as { n: number };
    expect(stale.n).toBe(1);
  });

  it("throws on non-array payloads", async () => {
    const db = memoryDb();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ nope: true })));
    await expect(congressFetcher.fetch({ db, config })).rejects.toThrow(/unexpected shape/);
  });
});
