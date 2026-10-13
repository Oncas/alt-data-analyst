import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  buildFilingsUrl,
  ldaFetcher,
  mapFiling,
  type LdaFilingRaw,
} from "../src/fetchers/lda.js";

const fixtureFiling: LdaFilingRaw = {
  filing_uuid: "abc-123",
  filing_type: "Q2",
  filing_year: 2026,
  filing_period: "second_quarter",
  income: "150000.00",
  expenses: null,
  dt_posted: "2026-07-18T14:23:11-04:00",
  registrant: { name: "Lobby Shop LLC" },
  client: { name: "Acme Robotics", general_description: "Industrial robots" },
  lobbying_activities: [
    { general_issue_code: "DEF" },
    { general_issue_code: "TAX" },
    { general_issue_code: "DEF" },
  ],
  filing_document_url: "https://lda.gov/filings/abc-123.pdf",
};

function testConfig(overrides: Partial<Config> = {}): Config {
  return { DB_PATH: ":memory:", MIN_CONTRACT_USD: 5_000_000, ...overrides } as Config;
}

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
    text: async () => JSON.stringify(body),
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("mapFiling", () => {
  it("maps a full filing, deduping issue codes", () => {
    const row = mapFiling(fixtureFiling);
    expect(row).toMatchObject({
      filingUuid: "abc-123",
      income: 150_000,
      expenses: null,
      registrant: "Lobby Shop LLC",
      client: "Acme Robotics",
    });
    expect(JSON.parse(row!.issueCodes)).toEqual(["DEF", "TAX"]);
  });

  it("rejects filings without uuid or dt_posted", () => {
    expect(mapFiling({ ...fixtureFiling, filing_uuid: undefined })).toBeNull();
    expect(mapFiling({ ...fixtureFiling, dt_posted: undefined })).toBeNull();
  });

  it("treats junk amounts as null", () => {
    expect(mapFiling({ ...fixtureFiling, income: "n/a" })?.income).toBeNull();
    expect(mapFiling({ ...fixtureFiling, income: "" })?.income).toBeNull();
  });
});

describe("buildFilingsUrl", () => {
  it("orders ascending by dt_posted with the posted-after filter", () => {
    const url = buildFilingsUrl("https://lda.gov/api/v1", "2026-07-05");
    expect(url).toContain("filing_dt_posted_after=2026-07-05");
    expect(url).toContain("ordering=dt_posted");
    expect(url).toContain("page_size=25");
  });
});

describe("ldaFetcher.fetch", () => {
  it("follows next links, advances the watermark, dedupes re-runs", async () => {
    const db = memoryDb();
    const page2Filing: LdaFilingRaw = {
      ...fixtureFiling,
      filing_uuid: "def-456",
      dt_posted: "2026-07-19T09:00:00-04:00",
    };
    const fetchMock = vi
      .fn()
      // resolveBase probe
      .mockResolvedValueOnce(jsonResponse({ results: [], next: null }))
      .mockResolvedValueOnce(
        jsonResponse({ results: [fixtureFiling], next: "https://lda.gov/api/v1/filings/?page=2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ results: [page2Filing], next: null }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ldaFetcher.fetch({ db, config: testConfig({ LDA_API_KEY: "k" }) });
    expect(result).toEqual({ inserted: 2, skipped: 0 });

    const watermark = db
      .prepare("SELECT watermark FROM fetch_state WHERE source = 'lda'")
      .get() as { watermark: string };
    expect(watermark.watermark).toBe("2026-07-19T09:00:00-04:00");

    // Re-run: same rows come back, all deduped.
    const rerunMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [], next: null }))
      .mockResolvedValueOnce(jsonResponse({ results: [fixtureFiling, page2Filing], next: null }));
    vi.stubGlobal("fetch", rerunMock);
    const rerun = await ldaFetcher.fetch({ db, config: testConfig({ LDA_API_KEY: "k" }) });
    expect(rerun).toEqual({ inserted: 0, skipped: 2 });
  });

  it("keeps partial progress when throttled mid-run", async () => {
    const db = memoryDb();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ results: [], next: null }))
      .mockResolvedValueOnce(
        jsonResponse({ results: [fixtureFiling], next: "https://lda.gov/api/v1/filings/?page=2" }),
      )
      .mockResolvedValueOnce(jsonResponse({ detail: "throttled" }, 429));
    vi.stubGlobal("fetch", fetchMock);

    const result = await ldaFetcher.fetch({ db, config: testConfig({ LDA_API_KEY: "k" }) });
    expect(result.inserted).toBe(1);
    const watermark = db
      .prepare("SELECT watermark FROM fetch_state WHERE source = 'lda'")
      .get() as { watermark: string };
    expect(watermark.watermark).toBe("2026-07-18T14:23:11-04:00");
  });

  it("falls back to the senate base when lda.gov is unreachable", async () => {
    const db = memoryDb();
    const fetchMock = vi
      .fn()
      .mockImplementation((url: string) => {
        if (String(url).startsWith("https://lda.gov")) {
          return Promise.resolve(jsonResponse({ detail: "denied" }, 403));
        }
        return Promise.resolve(jsonResponse({ results: [fixtureFiling], next: null }));
      });
    vi.stubGlobal("fetch", fetchMock);

    const result = await ldaFetcher.fetch({ db, config: testConfig({ LDA_API_KEY: "k" }) });
    expect(result.inserted).toBe(1);
    const calledBases = fetchMock.mock.calls.map((call) => String(call[0]));
    expect(calledBases.some((u) => u.startsWith("https://lda.senate.gov"))).toBe(true);
  });
});
