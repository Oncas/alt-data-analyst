import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Config } from "../src/config.js";
import { migrate, type Db } from "../src/db/index.js";
import {
  closeAsOf,
  closeFrom,
  latestClose,
  latestCloseFor,
  loadBars,
  moveAroundEvent,
  moveBetween,
  moveSince,
  moveSinceFor,
  pctChange,
  priceContext,
  priceContextFor,
  type PriceBar,
} from "../src/enrich/prices.js";
import {
  epochToExchangeDate,
  isBarInProgress,
  normalizeYahooTicker,
  parseChart,
  pricesFetcher,
  selectTickers,
  type ChartResponse,
} from "../src/fetchers/prices.js";
import { todayIso } from "../src/util/dates.js";

const config = { DB_PATH: ":memory:" } as Config;

function memoryDb(): Db {
  const db = new Database(":memory:");
  migrate(db);
  return db;
}

// Shape and values copied from a live query1.finance.yahoo.com response
// (AAPL, range=5d, captured 2026-07-22 mid-session). gmtoffset -14400 = EDT;
// bar timestamps are 13:30 UTC = 09:30 ET opens.
const SESSION_END = 1_784_750_400; // 2026-07-22 16:00 ET
const MID_SESSION = 1_784_744_414; // 2026-07-22 14:20 ET — market still open

function chartFixture(overrides: { regularMarketTime?: number } = {}): ChartResponse {
  return {
    chart: {
      result: [
        {
          meta: {
            gmtoffset: -14_400,
            regularMarketTime: overrides.regularMarketTime ?? MID_SESSION,
            currentTradingPeriod: { regular: { start: 1_784_727_000, end: SESSION_END } },
          },
          timestamp: [
            1_784_208_600, // 2026-07-16
            1_784_295_000, // 2026-07-17
            1_784_554_200, // 2026-07-20
            1_784_640_600, // 2026-07-21
            1_784_727_000, // 2026-07-22 (current session)
          ],
          indicators: {
            quote: [
              {
                open: [330.1, 333.0, 327.4, 326.0, 327.5],
                high: [335.0, 336.2, 329.9, 329.4, 329.0],
                low: [329.0, 331.1, 325.0, 325.2, 323.34],
                close: [333.26, 333.74, 326.59, 327.74, 323.86],
                volume: [62_970_600, 63_407_100, 53_468_000, 41_255_200, 18_764_258],
              },
            ],
          },
        },
      ],
      error: null,
    },
  };
}

function notFoundFixture(): ChartResponse {
  return {
    chart: {
      result: null,
      error: { code: "Not Found", description: "No data found, symbol may be delisted" },
    },
  };
}

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

function seedSignal(db: Db, ticker: string, key = ticker): void {
  db.prepare(
    `INSERT INTO signals (source, rule, dedupe_key, ticker) VALUES ('test', 'test.rule', ?, ?)`,
  ).run(key, ticker);
}

/** Pretend the last successful run was yesterday so the daily guard lets us in. */
function rewindWatermark(db: Db): void {
  db.prepare("UPDATE fetch_state SET watermark = '2000-01-01' WHERE source = 'prices'").run();
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("normalizeYahooTicker", () => {
  it("uppercases, folds dotted share classes to Yahoo's dash form", () => {
    expect(normalizeYahooTicker("aapl")).toBe("AAPL");
    expect(normalizeYahooTicker(" brk.b ")).toBe("BRK-B");
    expect(normalizeYahooTicker("BRK-B")).toBe("BRK-B");
  });

  it("rejects placeholders and non-symbols rather than building a junk URL", () => {
    expect(normalizeYahooTicker("--")).toBeNull();
    expect(normalizeYahooTicker("N/A")).toBeNull();
    expect(normalizeYahooTicker("")).toBeNull();
    expect(normalizeYahooTicker(null)).toBeNull();
    expect(normalizeYahooTicker(undefined)).toBeNull();
    expect(normalizeYahooTicker("../../etc/passwd")).toBeNull();
    expect(normalizeYahooTicker("TOOLONGSYMBOL")).toBeNull();
  });
});

describe("epochToExchangeDate", () => {
  it("renders the exchange-local date, not the UTC date", () => {
    expect(epochToExchangeDate(1_784_727_000, -14_400)).toBe("2026-07-22");
    // 20:00 ET on 07-22 is already 07-23 in UTC; exchange date must stay 07-22.
    expect(epochToExchangeDate(1_784_750_400, -14_400)).toBe("2026-07-22");
  });
});

describe("isBarInProgress", () => {
  const meta = {
    gmtoffset: -14_400,
    regularMarketTime: MID_SESSION,
    currentTradingPeriod: { regular: { end: SESSION_END } },
  };

  it("flags the current session's bar while the market is open", () => {
    expect(isBarInProgress(meta, 1_784_727_000)).toBe(true);
    expect(isBarInProgress(meta, 1_784_640_600)).toBe(false);
  });

  it("treats the bar as settled once the session has closed", () => {
    const closed = { ...meta, regularMarketTime: SESSION_END + 60 };
    expect(isBarInProgress(closed, 1_784_727_000)).toBe(false);
  });
});

describe("parseChart", () => {
  it("maps a realistic response to settled daily bars", () => {
    const rows = parseChart("AAPL", chartFixture());
    // Five timestamps in, four out: the in-progress session is dropped.
    expect(rows).toHaveLength(4);
    expect(rows[0]).toEqual({
      ticker: "AAPL",
      date: "2026-07-16",
      open: 330.1,
      high: 335.0,
      low: 329.0,
      close: 333.26,
      volume: 62_970_600,
    });
    expect(rows.at(-1)?.date).toBe("2026-07-21");
    expect(rows.map((r) => r.date)).not.toContain("2026-07-22");
  });

  it("keeps the final bar once the session has settled", () => {
    const rows = parseChart("AAPL", chartFixture({ regularMarketTime: SESSION_END + 60 }));
    expect(rows).toHaveLength(5);
    expect(rows.at(-1)).toMatchObject({ date: "2026-07-22", close: 323.86 });
  });

  it("drops bars with no close instead of inventing one", () => {
    const payload = chartFixture({ regularMarketTime: SESSION_END + 60 });
    payload.chart!.result![0]!.indicators!.quote![0]!.close = [
      333.26,
      null,
      326.59,
      327.74,
      323.86,
    ];
    const rows = parseChart("AAPL", payload);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.date)).not.toContain("2026-07-17");
  });

  it("nulls unusable volume without losing the bar", () => {
    const payload = chartFixture();
    payload.chart!.result![0]!.indicators!.quote![0]!.volume = [null, null, null, null, null];
    expect(parseChart("AAPL", payload)[0]).toMatchObject({ close: 333.26, volume: null });
  });

  it("throws with the upstream description for an unknown symbol", () => {
    expect(() => parseChart("ZZZZ", notFoundFixture())).toThrow(/symbol may be delisted/);
  });
});

describe("selectTickers", () => {
  it("takes signal tickers plus recent congress/insider names, deduped", () => {
    const db = memoryDb();
    seedSignal(db, "AGX");
    seedSignal(db, "LEU");
    seedSignal(db, "AGX", "agx-2"); // duplicate ticker, different signal
    db.prepare(
      `INSERT INTO congress_trades (source_id, filer_name, ticker, transaction_date)
       VALUES ('c1', 'Jane Doe', 'nvda', '2026-07-01'),
              ('c2', 'Jane Doe', 'OLD', '2020-01-01')`,
    ).run();
    db.prepare(
      `INSERT INTO insider_trades (accession, txn_index, ticker, transaction_code, transaction_date)
       VALUES ('a1', 0, 'SRFM', 'P', '2026-07-10')`,
    ).run();

    const tickers = selectTickers(db, { tradeSince: "2026-01-01", limit: 100 });
    expect(tickers).toContain("AGX");
    expect(tickers).toContain("LEU");
    expect(tickers).toContain("NVDA");
    expect(tickers).toContain("SRFM");
    // Outside the trade lookback window.
    expect(tickers).not.toContain("OLD");
    expect(new Set(tickers).size).toBe(tickers.length);
  });

  it("honours the cap and prioritises signal tickers over trade tickers", () => {
    const db = memoryDb();
    seedSignal(db, "AAA");
    db.prepare(
      `INSERT INTO congress_trades (source_id, filer_name, ticker, transaction_date)
       VALUES ('c1', 'Jane Doe', 'ZZZ', '2026-07-01')`,
    ).run();
    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 1 })).toEqual(["AAA"]);
  });

  it("rotates overflow: never-priced first, then stalest, so no ticker starves", () => {
    const db = memoryDb();
    // Alphabetically ZZZ sorts last, but it has no prices at all — under a naive
    // alphabetical order it would never be reached once the cap binds.
    for (const t of ["AAA", "BBB", "ZZZ"]) seedSignal(db, t);
    const insert = db.prepare("INSERT INTO prices (ticker, date, close) VALUES (?, ?, ?)");
    insert.run("AAA", "2026-07-21", 10); // freshest
    insert.run("BBB", "2026-07-10", 20); // stale

    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 1 })).toEqual(["ZZZ"]);
    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 2 })).toEqual(["ZZZ", "BBB"]);
    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 3 })).toEqual([
      "ZZZ",
      "BBB",
      "AAA",
    ]);
  });

  it("matches stored dash-form prices when the source table uses a dot", () => {
    const db = memoryDb();
    seedSignal(db, "BRK.B");
    seedSignal(db, "AAA");
    db.prepare("INSERT INTO prices (ticker, date, close) VALUES ('BRK-B', '2026-07-21', 490)").run();
    // BRK.B is already priced, so the never-priced AAA must be picked first.
    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 1 })).toEqual(["AAA"]);
  });

  it("does not pull the whole company_tickers universe", () => {
    const db = memoryDb();
    db.prepare(
      "INSERT INTO company_tickers (normalized_name, ticker) VALUES ('acme', 'ACME')",
    ).run();
    expect(selectTickers(db, { tradeSince: "2026-01-01", limit: 100 })).toEqual([]);
  });
});

describe("pricesFetcher.fetch", () => {
  it("inserts bars, dedupes re-runs, and advances the watermark", async () => {
    const db = memoryDb();
    seedSignal(db, "AAPL");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chartFixture()));
    vi.stubGlobal("fetch", fetchMock);

    const first = await pricesFetcher.fetch({ db, config });
    expect(first).toEqual({ inserted: 4, skipped: 0 });
    expect(db.prepare("SELECT watermark FROM fetch_state WHERE source = 'prices'").get()).toEqual({
      watermark: todayIso(),
    });

    // Same day again: the daily guard short-circuits without any HTTP.
    fetchMock.mockClear();
    expect(await pricesFetcher.fetch({ db, config })).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();

    // Next day: same bars arrive again and all dedupe via INSERT OR IGNORE.
    rewindWatermark(db);
    const second = await pricesFetcher.fetch({ db, config });
    expect(second).toEqual({ inserted: 0, skipped: 4 });
    expect(db.prepare("SELECT COUNT(*) n FROM prices").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT watermark FROM fetch_state WHERE source = 'prices'").get()).toEqual({
      watermark: todayIso(),
    });
  });

  it("backfills a year on first sight, then goes incremental", async () => {
    const db = memoryDb();
    seedSignal(db, "AAPL");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(chartFixture()));
    vi.stubGlobal("fetch", fetchMock);

    await pricesFetcher.fetch({ db, config });
    expect(String(fetchMock.mock.calls[0]![0])).toContain("range=1y");

    rewindWatermark(db);
    await pricesFetcher.fetch({ db, config });
    expect(String(fetchMock.mock.calls[1]![0])).toContain("range=1mo");
  });

  it("skips a failing ticker without aborting the run", async () => {
    const db = memoryDb();
    seedSignal(db, "AAPL");
    seedSignal(db, "ZZZZ");
    seedSignal(db, "LEU");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation((url: string) => {
        if (String(url).includes("/ZZZZ")) {
          return Promise.resolve(jsonResponse(notFoundFixture(), 404));
        }
        return Promise.resolve(jsonResponse(chartFixture()));
      }),
    );

    const result = await pricesFetcher.fetch({ db, config });
    // 4 bars each for AAPL and LEU; the dead symbol counts as one skip.
    expect(result.inserted).toBe(8);
    expect(result.skipped).toBe(1);
    const tickers = db
      .prepare("SELECT DISTINCT ticker FROM prices ORDER BY ticker")
      .all() as { ticker: string }[];
    expect(tickers.map((t) => t.ticker)).toEqual(["AAPL", "LEU"]);
    expect(db.prepare("SELECT watermark FROM fetch_state WHERE source = 'prices'").get()).toEqual({
      watermark: todayIso(),
    });
  });

  it("throws and holds the watermark back when every ticker fails", async () => {
    const db = memoryDb();
    seedSignal(db, "AAPL");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse("Edge: Too Many Requests", 429)));

    await expect(pricesFetcher.fetch({ db, config })).rejects.toThrow(/all 1 ticker\(s\) failed/);
    expect(
      db.prepare("SELECT watermark FROM fetch_state WHERE source = 'prices'").get(),
    ).toBeUndefined();
  });

  it("is a no-op when nothing has been flagged yet", async () => {
    const db = memoryDb();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await pricesFetcher.fetch({ db, config })).toEqual({ inserted: 0, skipped: 0 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------- pure price math ----------

const bars: PriceBar[] = [
  { date: "2026-07-01", close: 100 },
  { date: "2026-07-02", close: 110 },
  { date: "2026-07-06", close: 105 },
  { date: "2026-07-07", close: 150 },
];

describe("pctChange", () => {
  it("computes a signed percent move", () => {
    expect(pctChange(100, 150)).toBe(50);
    expect(pctChange(100, 75)).toBe(-25);
    expect(pctChange(100, 100)).toBe(0);
  });

  it("returns null rather than Infinity or NaN on a bad base", () => {
    expect(pctChange(0, 50)).toBeNull();
    expect(pctChange(Number.NaN, 50)).toBeNull();
    expect(pctChange(100, Number.NaN)).toBeNull();
  });
});

describe("closeAsOf / closeFrom / latestClose", () => {
  it("anchors on the last close at or before the date", () => {
    expect(closeAsOf(bars, "2026-07-02")).toEqual({ date: "2026-07-02", close: 110 });
    // 07-04 is a holiday: fall back to the prior session.
    expect(closeAsOf(bars, "2026-07-05")).toEqual({ date: "2026-07-02", close: 110 });
  });

  it("returns null before the first bar and for an empty series", () => {
    expect(closeAsOf(bars, "2026-06-30")).toBeNull();
    expect(closeAsOf([], "2026-07-02")).toBeNull();
    expect(latestClose([])).toBeNull();
    expect(closeFrom([], "2026-07-02")).toBeNull();
  });

  it("finds the first close on or after a date", () => {
    expect(closeFrom(bars, "2026-07-03")).toEqual({ date: "2026-07-06", close: 105 });
    expect(closeFrom(bars, "2026-07-08")).toBeNull();
  });

  it("sorts defensively rather than trusting caller order", () => {
    const shuffled = [bars[3]!, bars[0]!, bars[2]!, bars[1]!];
    expect(latestClose(shuffled)).toEqual({ date: "2026-07-07", close: 150 });
    expect(closeAsOf(shuffled, "2026-07-02")).toEqual({ date: "2026-07-02", close: 110 });
  });
});

describe("moveBetween", () => {
  it("measures the move and the sessions spanned", () => {
    expect(moveBetween(bars, "2026-07-01", "2026-07-07")).toEqual({
      fromDate: "2026-07-01",
      fromClose: 100,
      toDate: "2026-07-07",
      toClose: 150,
      pctChange: 50,
      tradingDays: 3,
    });
  });

  it("returns null when the window has no data", () => {
    expect(moveBetween([], "2026-07-01", "2026-07-07")).toBeNull();
    // Start predates every bar we hold.
    expect(moveBetween(bars, "2026-06-01", "2026-06-15")).toBeNull();
    // Both ends collapse onto one bar — 0% would be a fabrication.
    expect(moveBetween(bars, "2026-07-02", "2026-07-03")).toBeNull();
    // Inverted window.
    expect(moveBetween(bars, "2026-07-07", "2026-07-01")).toBeNull();
  });
});

describe("moveSince / moveAroundEvent", () => {
  it("runs from the event date through the latest close", () => {
    expect(moveSince(bars, "2026-07-02")).toMatchObject({
      fromDate: "2026-07-02",
      toDate: "2026-07-07",
      pctChange: expect.closeTo(36.36, 2),
    });
  });

  it("starts before the event so announcement-day action is inside the window", () => {
    // Event on 07-06; a 3-day lead-in reaches back to 07-02 (07-03 is a holiday),
    // capturing the drop into the event AND the spike after it.
    const around = moveAroundEvent(bars, "2026-07-06", { leadDays: 3 });
    expect(around).toMatchObject({ fromDate: "2026-07-02", toDate: "2026-07-07" });
    // Measuring from the event date alone would understate the move.
    expect(around!.pctChange).toBeLessThan(moveSince(bars, "2026-07-06")!.pctChange);
  });

  it("returns null when the ticker has no bars", () => {
    expect(moveSince([], "2026-07-02")).toBeNull();
    expect(moveAroundEvent([], "2026-07-06")).toBeNull();
  });
});

describe("priceContext", () => {
  it("bundles latest close with both event windows", () => {
    const context = priceContext(bars, "2026-07-06", { leadDays: 3 });
    expect(context.latest).toEqual({ date: "2026-07-07", close: 150 });
    expect(context.sinceEvent?.pctChange).toBeCloseTo(42.86, 2);
    expect(context.aroundEvent?.fromDate).toBe("2026-07-02");
  });

  it("reports missing data as null across the board", () => {
    expect(priceContext([], "2026-07-06")).toEqual({
      latest: null,
      sinceEvent: null,
      aroundEvent: null,
    });
  });
});

// ---------- SQL wrappers ----------

describe("SQL wrappers", () => {
  function dbWithBars(ticker = "AGX"): Db {
    const db = memoryDb();
    const insert = db.prepare(
      "INSERT INTO prices (ticker, date, close, volume) VALUES (?, ?, ?, ?)",
    );
    for (const bar of bars) insert.run(ticker, bar.date, bar.close, 1000);
    return db;
  }

  it("loads bars ascending and honours the since filter", () => {
    const db = dbWithBars();
    expect(loadBars(db, "AGX")).toEqual(bars);
    expect(loadBars(db, "AGX", { since: "2026-07-06" })).toEqual(bars.slice(2));
  });

  it("normalizes the ticker on the way in", () => {
    const db = dbWithBars("BRK-B");
    expect(loadBars(db, "brk.b")).toHaveLength(4);
  });

  it("returns empty/null for a ticker we hold nothing for", () => {
    const db = dbWithBars();
    expect(loadBars(db, "NOPE")).toEqual([]);
    expect(loadBars(db, "--")).toEqual([]);
    expect(latestCloseFor(db, "NOPE")).toBeNull();
    expect(moveSinceFor(db, "NOPE", "2026-07-01")).toBeNull();
    expect(priceContextFor(db, "NOPE", "2026-07-06")).toEqual({
      latest: null,
      sinceEvent: null,
      aroundEvent: null,
    });
  });

  it("answers the report layer's question end to end", () => {
    const db = dbWithBars();
    expect(latestCloseFor(db, "AGX")).toEqual({ date: "2026-07-07", close: 150 });
    expect(moveSinceFor(db, "AGX", "2026-07-01")?.pctChange).toBe(50);
    const context = priceContextFor(db, "AGX", "2026-07-06", { leadDays: 3 });
    expect(context.aroundEvent?.fromDate).toBe("2026-07-02");
    expect(context.sinceEvent?.pctChange).toBeCloseTo(42.86, 2);
  });
});
