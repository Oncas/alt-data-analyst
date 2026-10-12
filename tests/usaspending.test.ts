import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  buildRequestBody,
  mapRow,
  usaspendingFetcher,
  type UsaspendingRow,
} from "../src/fetchers/usaspending.js";

const fixtureRow: UsaspendingRow = {
  internal_id: 987654,
  "Award ID": "W91QUZ26C0042",
  Mod: "P00003",
  "Recipient Name": "ACME DEFENSE SYSTEMS LLC",
  "Transaction Amount": 12_500_000,
  "Action Date": "2026-07-15",
  "Awarding Agency": "Department of Defense",
  "Awarding Sub Agency": "Department of the Army",
  naics_code: "336411",
  product_or_service_code: "1510",
  "Transaction Description": "AIRCRAFT COMPONENTS",
};

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    DB_PATH: ":memory:",
    MIN_CONTRACT_USD: 5_000_000,
    ...overrides,
  } as Config;
}

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

function pageResponse(rows: UsaspendingRow[], hasNext: boolean) {
  return {
    ok: true,
    json: async () => ({ results: rows, page_metadata: { hasNext } }),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("buildRequestBody", () => {
  it("filters to contracts by action_date, sorted by amount desc", () => {
    const body = buildRequestBody("2026-06-19", "2026-07-19", 3);
    expect(body.filters.award_type_codes).toEqual(["A", "B", "C", "D"]);
    expect(body.filters.time_period).toEqual([
      { start_date: "2026-06-19", end_date: "2026-07-19", date_type: "action_date" },
    ]);
    expect(body.sort).toBe("Transaction Amount");
    expect(body.order).toBe("desc");
    expect(body.page).toBe(3);
    expect(body.fields).toContain("Recipient Name");
  });
});

describe("mapRow", () => {
  it("maps a full API row", () => {
    const row = mapRow(fixtureRow);
    expect(row).toMatchObject({
      naturalKey: "usa:987654",
      awardId: "W91QUZ26C0042",
      recipient: "ACME DEFENSE SYSTEMS LLC",
      amount: 12_500_000,
      actionDate: "2026-07-15",
      naics: "336411",
    });
  });

  it("rejects rows missing identity fields", () => {
    expect(mapRow({ ...fixtureRow, "Award ID": undefined })).toBeNull();
    expect(mapRow({ ...fixtureRow, "Recipient Name": "  " })).toBeNull();
    expect(mapRow({ ...fixtureRow, "Action Date": undefined })).toBeNull();
  });

  it("builds a composite key when internal_id is absent", () => {
    const row = mapRow({ ...fixtureRow, internal_id: undefined });
    expect(row?.naturalKey).toBe("usa:W91QUZ26C0042|P00003|2026-07-15|12500000");
  });

  it("tolerates junk amounts", () => {
    const row = mapRow({ ...fixtureRow, "Transaction Amount": "not-a-number" });
    expect(row?.amount).toBeNull();
  });
});

describe("usaspendingFetcher.fetch", () => {
  it("inserts rows, dedupes re-runs, and advances the watermark", async () => {
    const db = memoryDb();
    const fetchMock = vi.fn().mockResolvedValue(pageResponse([fixtureRow], false));
    vi.stubGlobal("fetch", fetchMock);

    const first = await usaspendingFetcher.fetch({ db, config: testConfig() });
    expect(first).toEqual({ inserted: 1, skipped: 0 });

    const second = await usaspendingFetcher.fetch({ db, config: testConfig() });
    expect(second).toEqual({ inserted: 0, skipped: 1 });

    const count = db.prepare("SELECT COUNT(*) AS n FROM contracts").get() as { n: number };
    expect(count.n).toBe(1);
    const watermark = db
      .prepare("SELECT watermark FROM fetch_state WHERE source = 'usaspending'")
      .get() as { watermark: string };
    expect(watermark.watermark).toBe(new Date().toISOString().slice(0, 10));
  });

  it("stops paging once amounts fall below the threshold", async () => {
    const db = memoryDb();
    const small: UsaspendingRow = {
      ...fixtureRow,
      internal_id: 111,
      "Transaction Amount": 40_000,
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(pageResponse([fixtureRow, small], true));
    vi.stubGlobal("fetch", fetchMock);

    const result = await usaspendingFetcher.fetch({ db, config: testConfig() });
    // Only the large row lands; hasNext was true but the threshold ends paging.
    expect(result.inserted).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces API errors", async () => {
    const db = memoryDb();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "boom",
      } as Response),
    );
    await expect(
      usaspendingFetcher.fetch({ db, config: testConfig() }),
    ).rejects.toThrow(/USAspending 500/);
  });
});
