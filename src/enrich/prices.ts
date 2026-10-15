import type { Db } from "../db/index.js";
import { normalizeYahooTicker } from "../fetchers/prices.js";
import { shiftDate } from "../util/dates.js";

/**
 * Price context for signals. The report layer's core question is "has the market
 * already reacted?" — federal contract signals average ~23 days stale, so a name
 * can be up 40% before we ever print it.
 *
 * Every function here returns null when the data can't answer the question.
 * There is no fallback price: a missing close is reported as missing.
 */

export interface PriceBar {
  date: string;
  close: number;
}

export interface PriceMove {
  fromDate: string;
  fromClose: number;
  toDate: string;
  toClose: number;
  /** Percent, signed: 12.5 means +12.5%. */
  pctChange: number;
  /** Sessions elapsed between the two bars. */
  tradingDays: number;
}

/** Default lead-in for "did this already move?" — captures announcement-day spikes. */
export const DEFAULT_LEAD_DAYS = 3;

// ---------- pure price math ----------

/** Signed percent change. Null unless both ends are usable and the base is non-zero. */
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

function sorted(bars: PriceBar[]): PriceBar[] {
  return [...bars].sort((a, b) => a.date.localeCompare(b.date));
}

/** Index of the last bar on or before `date`, or -1. Bars must be ascending. */
function indexAsOf(bars: PriceBar[], date: string): number {
  let found = -1;
  for (const [index, bar] of bars.entries()) {
    if (bar.date <= date) found = index;
    else break;
  }
  return found;
}

/** Last close on or before `date` — the price a reader would have seen then. */
export function closeAsOf(bars: PriceBar[], date: string): PriceBar | null {
  const ascending = sorted(bars);
  const index = indexAsOf(ascending, date);
  return index === -1 ? null : ascending[index]!;
}

/** First close on or after `date`. */
export function closeFrom(bars: PriceBar[], date: string): PriceBar | null {
  return sorted(bars).find((bar) => bar.date >= date) ?? null;
}

/** Most recent close we hold. */
export function latestClose(bars: PriceBar[]): PriceBar | null {
  return sorted(bars).at(-1) ?? null;
}

/**
 * Move between two dates, anchored on the last close at or before each end.
 * Null when either end has no data, or when both ends land on the same bar
 * (a window containing one session tells us nothing — 0% would be a lie).
 */
export function moveBetween(
  bars: PriceBar[],
  startDate: string,
  endDate: string,
): PriceMove | null {
  if (bars.length === 0 || endDate < startDate) return null;
  const ascending = sorted(bars);
  const fromIndex = indexAsOf(ascending, startDate);
  const toIndex = indexAsOf(ascending, endDate);
  if (fromIndex === -1 || toIndex === -1 || fromIndex === toIndex) return null;

  const from = ascending[fromIndex]!;
  const to = ascending[toIndex]!;
  const pct = pctChange(from.close, to.close);
  if (pct === null) return null;

  return {
    fromDate: from.date,
    fromClose: from.close,
    toDate: to.date,
    toClose: to.close,
    pctChange: pct,
    tradingDays: toIndex - fromIndex,
  };
}

/** Move from a given date through the latest close we hold. */
export function moveSince(bars: PriceBar[], sinceDate: string): PriceMove | null {
  const latest = latestClose(bars);
  if (!latest) return null;
  return moveBetween(bars, sinceDate, latest.date);
}

/**
 * "Did this already move?" — measured from a few sessions BEFORE the event through
 * the latest close, so a spike on the announcement day itself falls inside the
 * window instead of being used as the baseline.
 */
export function moveAroundEvent(
  bars: PriceBar[],
  eventDate: string,
  opts: { leadDays?: number } = {},
): PriceMove | null {
  return moveSince(bars, shiftDate(eventDate, -(opts.leadDays ?? DEFAULT_LEAD_DAYS)));
}

export interface PriceContext {
  /** Latest close on file, or null if we hold no prices for this ticker. */
  latest: PriceBar | null;
  /** Move from the event date through the latest close. */
  sinceEvent: PriceMove | null;
  /** Move from `leadDays` before the event — includes announcement-day action. */
  aroundEvent: PriceMove | null;
}

/** Everything the report layer needs about one ticker around one event date. */
export function priceContext(
  bars: PriceBar[],
  eventDate: string,
  opts: { leadDays?: number } = {},
): PriceContext {
  return {
    latest: latestClose(bars),
    sinceEvent: moveSince(bars, eventDate),
    aroundEvent: moveAroundEvent(bars, eventDate, opts),
  };
}

// ---------- SQL wrappers ----------

/** Daily closes for a ticker, ascending. Empty array when we hold nothing. */
export function loadBars(db: Db, ticker: string, opts: { since?: string } = {}): PriceBar[] {
  const normalized = normalizeYahooTicker(ticker);
  if (!normalized) return [];
  const since = opts.since ?? "0000-01-01";
  return db
    .prepare(
      `SELECT date, close FROM prices
       WHERE ticker = ? AND date >= ?
       ORDER BY date`,
    )
    .all(normalized, since) as PriceBar[];
}

/** Latest stored close for a ticker, or null. */
export function latestCloseFor(db: Db, ticker: string): PriceBar | null {
  return latestClose(loadBars(db, ticker));
}

/** Move for a ticker from `sinceDate` through the latest close, or null. */
export function moveSinceFor(db: Db, ticker: string, sinceDate: string): PriceMove | null {
  // Pull a small lead-in so the baseline can fall on an earlier session when
  // sinceDate is a weekend or holiday.
  return moveSince(loadBars(db, ticker, { since: shiftDate(sinceDate, -10) }), sinceDate);
}

/** Full price context for a ticker around a signal/event date. */
export function priceContextFor(
  db: Db,
  ticker: string,
  eventDate: string,
  opts: { leadDays?: number } = {},
): PriceContext {
  const lead = opts.leadDays ?? DEFAULT_LEAD_DAYS;
  const bars = loadBars(db, ticker, { since: shiftDate(eventDate, -(lead + 10)) });
  return priceContext(bars, eventDate, opts);
}
