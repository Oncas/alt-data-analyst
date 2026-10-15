import type { Db, SignalInput } from "../db/index.js";
import { loadOverrides, lookupTicker, type OverrideMap } from "../enrich/tickers.js";

/**
 * What a rule wants when its company does NOT resolve to a public ticker.
 * - "drop":   emit nothing. For rules whose unresolvable candidates are noise
 *             (community colleges, county governments, JVs, lab operators).
 * - "demote": still emit, one severity notch lower. For rules where the fact is
 *             contextually interesting even for a private company, and may
 *             resolve later once the overrides file grows.
 */
export type UnresolvedPolicy = "drop" | "demote";

/**
 * Declarative opt-in, keyed by rule name. A new rule joins the scheme by adding
 * one line here — no lookup or gating code is duplicated into the rule itself.
 * Rules absent from this map are passed through untouched.
 *
 * Rates measured on the first weekly report (share of signals resolving to a
 * public ticker) motivate each entry:
 *   lobbying.new-registration      7%  -> drop
 *   contracts.new-large-recipient  8%  -> drop
 *   contracts.mega-award          17%  -> demote (a $900M award still says something)
 *   lobbying.watched-issue        26%  -> demote
 */
export const TICKER_POLICY: Readonly<Record<string, UnresolvedPolicy>> = {
  "lobbying.new-registration": "drop",
  "contracts.new-large-recipient": "drop",
  "lobbying.watched-issue": "demote",
  "contracts.mega-award": "demote",
};

/** Demotion never pushes a signal below the lowest real severity. */
export const MIN_SEVERITY = 1;

/** Resolves a company name to a ticker, or null when there is no public match. */
export type TickerResolver = (companyName: string | undefined) => string | null;

/**
 * One resolver per rule run. The overrides file is read at most once (lazily, so
 * a rule with no gated signals never touches disk) and each distinct company
 * name is looked up once, no matter how many candidate rows carry it.
 */
export function createTickerResolver(db: Db, overrides?: OverrideMap): TickerResolver {
  const cache = new Map<string, string | null>();
  let loaded = overrides;
  return (companyName) => {
    if (!companyName) return null;
    if (cache.has(companyName)) return cache.get(companyName) ?? null;
    loaded ??= loadOverrides();
    // No second matcher and no fuzzy fallback — DECISIONS.md D6.
    const ticker = lookupTicker(db, companyName, loaded);
    cache.set(companyName, ticker);
    return ticker;
  };
}

/**
 * Apply each signal's declared ticker policy.
 *
 * Resolvable    -> keep, carrying the ticker so the signal is tradeable on sight
 *                  (the post-screen enrichment pass stays as a backstop).
 * Unresolvable  -> dropped or demoted per {@link TICKER_POLICY}.
 * No policy     -> untouched.
 *
 * Pure given a resolver, so gating/demotion is unit-testable without SQL.
 */
export function applyTickerPolicy(
  signals: SignalInput[],
  resolve: TickerResolver,
  policies: Readonly<Record<string, UnresolvedPolicy>> = TICKER_POLICY,
): SignalInput[] {
  return signals.flatMap((signal) => {
    const policy = policies[signal.rule];
    if (!policy) return [signal];
    const ticker = resolve(signal.company);
    if (ticker) return [{ ...signal, ticker }];
    if (policy === "drop") return [];
    return [
      { ...signal, severity: Math.max(MIN_SEVERITY, (signal.severity ?? MIN_SEVERITY) - 1) },
    ];
  });
}
