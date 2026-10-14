import { insertSignal, type SignalInput } from "../db/index.js";
import { fmtUsd, registerEvidenceFormatter } from "../report/digest.js";
import { shiftDate } from "../util/dates.js";
import { buildSignalIndex, matchSignal, type OtherSignalRef } from "./crossSource.js";
import type { Rule, RuleContext } from "./index.js";

const SOURCE = "congress";

export const CLUSTER_WINDOW_DAYS = 14;
export const CLUSTER_MIN_MEMBERS = 3;
export const RECENT_WINDOW_DAYS = 30;
export const TOP_BAND_MIN_LOW_USD = 1_000_000;
export const FAST_FILING_MAX_DAYS = 3;
export const FAST_FILING_MIN_LOW_USD = 15_001;
export const CROSS_SOURCE_SIGNAL_AGE_DAYS = 30;

registerEvidenceFormatter("congress.cluster-buys", (e) =>
  `${e.memberCount} member(s) bought within ${e.windowDays}d ` +
  `(${Array.isArray(e.members) ? e.members.join("; ") : "?"}) — ` +
  `disclosed amounts ≥ ${fmtUsd(Number(e.totalLowUsd))}`,
);
registerEvidenceFormatter("congress.top-band-buy", (e) =>
  `${e.filer} (${e.officeOrChamber ?? "?"}) bought ${e.amountLabel} of ${e.asset} ` +
  `on ${e.date}${e.docUrl ? ` — filing: ${e.docUrl}` : ""}`,
);
registerEvidenceFormatter("congress.cross-source-buy", (e) =>
  `${e.filer} bought ${e.amountLabel ?? "?"} on ${e.date}; ` +
  `company also flagged by ${e.otherRule} (${e.otherSource})`,
);
registerEvidenceFormatter("congress.fast-filing", (e) =>
  `${e.filer} disclosed a ${e.amountLabel ?? "?"} buy in ${e.daysToFile} day(s) ` +
  `(vs 45 allowed) — ${e.asset}, ${e.date}`,
);

// ---------- pure rule logic ----------

export interface CongressBuy {
  sourceId: string;
  filerName: string;
  chamber: string | null;
  office: string | null;
  ticker: string | null;
  assetName: string | null;
  transactionDate: string | null;
  amountLow: number | null;
  amountLabel: string | null;
  daysToFile: number | null;
  docUrl: string | null;
}

/** ≥N distinct members buying the same ticker inside a trailing window. */
export function clusterBuySignals(
  buys: CongressBuy[],
  opts: { windowEnd: string; windowDays: number; minMembers: number },
): SignalInput[] {
  const windowStart = shiftDate(opts.windowEnd, -opts.windowDays);
  const byTicker = new Map<string, CongressBuy[]>();
  for (const buy of buys) {
    if (!buy.ticker || !buy.transactionDate) continue;
    if (buy.transactionDate < windowStart || buy.transactionDate > opts.windowEnd) continue;
    const list = byTicker.get(buy.ticker) ?? [];
    list.push(buy);
    byTicker.set(buy.ticker, list);
  }

  const signals: SignalInput[] = [];
  for (const [ticker, group] of byTicker) {
    const members = [...new Set(group.map((buy) => buy.filerName))];
    if (members.length < opts.minMembers) continue;
    const totalLowUsd = group.reduce((sum, buy) => sum + (buy.amountLow ?? 0), 0);
    const lastDate = group.map((buy) => buy.transactionDate!).sort().at(-1)!;
    signals.push({
      source: SOURCE,
      rule: "congress.cluster-buys",
      dedupeKey: `${ticker}|${lastDate}`,
      company: group[0]!.assetName ?? undefined,
      ticker,
      severity: members.length >= 5 ? 3 : 2,
      evidence: {
        memberCount: members.length,
        members: members.slice(0, 6),
        totalLowUsd,
        windowDays: opts.windowDays,
        lastDate,
      },
    });
  }
  return signals;
}

/**
 * Purchases disclosed in the top amount bands ($1M+). Ticker required — $1M+
 * into Treasuries/bonds is routine cash parking, not an equity signal.
 */
export function topBandBuySignals(buys: CongressBuy[], minLowUsd: number): SignalInput[] {
  return buys
    .filter((buy) => buy.ticker !== null && buy.amountLow !== null && buy.amountLow >= minLowUsd)
    .map((buy) => ({
      source: SOURCE,
      rule: "congress.top-band-buy",
      dedupeKey: buy.sourceId,
      company: buy.assetName ?? undefined,
      ticker: buy.ticker ?? undefined,
      severity: 3,
      evidence: {
        filer: buy.filerName,
        officeOrChamber: buy.office ?? buy.chamber,
        amountLabel: buy.amountLabel,
        asset: buy.assetName ?? buy.ticker,
        date: buy.transactionDate,
        docUrl: buy.docUrl,
      },
    }));
}

/** Member purchase at a company independently flagged by another source. */
export function crossSourceCongressSignals(
  buys: CongressBuy[],
  others: OtherSignalRef[],
): SignalInput[] {
  const index = buildSignalIndex(others);
  return buys.flatMap((buy) => {
    const match = matchSignal(index, buy.ticker, buy.assetName);
    if (!match) return [];
    return [
      {
        source: SOURCE,
        rule: "congress.cross-source-buy",
        dedupeKey: buy.sourceId,
        company: buy.assetName ?? undefined,
        ticker: buy.ticker ?? undefined,
        severity: 3,
        evidence: {
          filer: buy.filerName,
          amountLabel: buy.amountLabel,
          date: buy.transactionDate,
          otherSource: match.source,
          otherRule: match.rule,
        },
      },
    ];
  });
}

/** Unusually prompt disclosure of a meaningful equity buy (45 days allowed). */
export function fastFilingSignals(
  buys: CongressBuy[],
  opts: { maxDays: number; minLowUsd: number },
): SignalInput[] {
  return buys
    .filter(
      (buy) =>
        buy.ticker !== null &&
        buy.daysToFile !== null &&
        buy.daysToFile >= 0 &&
        buy.daysToFile <= opts.maxDays &&
        buy.amountLow !== null &&
        buy.amountLow >= opts.minLowUsd,
    )
    .map((buy) => ({
      source: SOURCE,
      rule: "congress.fast-filing",
      dedupeKey: buy.sourceId,
      company: buy.assetName ?? undefined,
      ticker: buy.ticker ?? undefined,
      severity: 1,
      evidence: {
        filer: buy.filerName,
        daysToFile: buy.daysToFile,
        amountLabel: buy.amountLabel,
        asset: buy.assetName ?? buy.ticker,
        date: buy.transactionDate,
      },
    }));
}

// ---------- SQL wrappers ----------

function persist(ctx: RuleContext, signals: SignalInput[]): number {
  return signals.filter((signal) => insertSignal(ctx.db, signal)).length;
}

function latestPurchaseDate(ctx: RuleContext): string | null {
  const row = ctx.db
    .prepare(
      `SELECT MAX(transaction_date) hi FROM congress_trades
       WHERE transaction_type LIKE 'purchase%'`,
    )
    .get() as { hi: string | null };
  return row.hi;
}

function loadRecentPurchases(ctx: RuleContext, sinceDays: number): CongressBuy[] {
  const windowEnd = latestPurchaseDate(ctx);
  if (!windowEnd) return [];
  return ctx.db
    .prepare(
      `SELECT source_id sourceId, filer_name filerName, chamber, office, ticker,
              asset_name assetName, transaction_date transactionDate,
              amount_low amountLow, amount_label amountLabel,
              days_to_file daysToFile, doc_url docUrl
       FROM congress_trades
       WHERE transaction_type LIKE 'purchase%' AND transaction_date >= ?`,
    )
    .all(shiftDate(windowEnd, -sinceDays)) as CongressBuy[];
}

const clusterRule: Rule = {
  name: "congress.cluster-buys",
  run(ctx) {
    const windowEnd = latestPurchaseDate(ctx);
    if (!windowEnd) return 0;
    return persist(
      ctx,
      clusterBuySignals(loadRecentPurchases(ctx, CLUSTER_WINDOW_DAYS), {
        windowEnd,
        windowDays: CLUSTER_WINDOW_DAYS,
        minMembers: CLUSTER_MIN_MEMBERS,
      }),
    );
  },
};

const topBandRule: Rule = {
  name: "congress.top-band-buy",
  run(ctx) {
    return persist(
      ctx,
      topBandBuySignals(loadRecentPurchases(ctx, RECENT_WINDOW_DAYS), TOP_BAND_MIN_LOW_USD),
    );
  },
};

const crossSourceRule: Rule = {
  name: "congress.cross-source-buy",
  run(ctx) {
    const others = ctx.db
      .prepare(
        `SELECT source, rule, company, ticker FROM signals
         WHERE source NOT IN (?, 'edgar-form4') AND rule NOT LIKE 'meta.%'
           AND created_at >= datetime('now', ?)`,
      )
      .all(SOURCE, `-${CROSS_SOURCE_SIGNAL_AGE_DAYS} days`) as OtherSignalRef[];
    return persist(
      ctx,
      crossSourceCongressSignals(loadRecentPurchases(ctx, RECENT_WINDOW_DAYS), others),
    );
  },
};

const fastFilingRule: Rule = {
  name: "congress.fast-filing",
  run(ctx) {
    return persist(
      ctx,
      fastFilingSignals(loadRecentPurchases(ctx, RECENT_WINDOW_DAYS), {
        maxDays: FAST_FILING_MAX_DAYS,
        minLowUsd: FAST_FILING_MIN_LOW_USD,
      }),
    );
  },
};

export const congressRules: Rule[] = [clusterRule, topBandRule, crossSourceRule, fastFilingRule];
