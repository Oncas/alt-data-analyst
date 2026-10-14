import { normalizeCompanyName } from "../util/companies.js";

/** A signal from another source to join against (ticker preferred, name fallback). */
export interface OtherSignalRef {
  source: string;
  rule: string;
  company: string | null;
  ticker: string | null;
}

export interface SignalIndex {
  byTicker: Map<string, OtherSignalRef>;
  byName: Map<string, OtherSignalRef>;
}

export function buildSignalIndex(others: OtherSignalRef[]): SignalIndex {
  const byTicker = new Map<string, OtherSignalRef>();
  const byName = new Map<string, OtherSignalRef>();
  for (const other of others) {
    if (other.ticker) byTicker.set(other.ticker.toUpperCase(), other);
    if (other.company) byName.set(normalizeCompanyName(other.company), other);
  }
  return { byTicker, byName };
}

/** Ticker match wins; falls back to conservative normalized-name match. */
export function matchSignal(
  index: SignalIndex,
  ticker: string | null,
  companyName: string | null,
): OtherSignalRef | undefined {
  return (
    (ticker ? index.byTicker.get(ticker.toUpperCase()) : undefined) ??
    (companyName ? index.byName.get(normalizeCompanyName(companyName)) : undefined)
  );
}
