import { insertSignal, type SignalInput } from "../db/index.js";
import { fmtUsd, registerEvidenceFormatter } from "../report/digest.js";
import { shiftDate } from "../util/dates.js";
import { buildSignalIndex, matchSignal, type OtherSignalRef } from "./crossSource.js";
import type { Rule, RuleContext } from "./index.js";

const SOURCE = "edgar-form4";

export const CLUSTER_WINDOW_DAYS = 14;
export const CLUSTER_MIN_INSIDERS = 2;
/** Two insiders buying pocket change isn't a signal. */
export const CLUSTER_MIN_TOTAL_USD = 25_000;
export const CROSS_SOURCE_SIGNAL_AGE_DAYS = 30;
export const CROSS_SOURCE_MIN_BUY_USD = 50_000;
const EXEC_ROLE = /chief|ceo|cfo|coo|president/i;

registerEvidenceFormatter("insiders.cluster-buys", (e) =>
  `${e.insiderCount} insider(s) bought within ${e.windowDays}d ` +
  `(${Array.isArray(e.insiders) ? e.insiders.join("; ") : "?"}) — total ${fmtUsd(Number(e.totalUsd))}`,
);
registerEvidenceFormatter("insiders.big-exec-buy", (e) =>
  `${e.insiderName} (${e.role}) bought ${fmtUsd(Number(e.valueUsd))} on ${e.date}` +
  (e.shares ? ` — ${Number(e.shares).toLocaleString("en-US")} shares` : ""),
);
registerEvidenceFormatter("insiders.cross-source-buy", (e) =>
  `${e.insiderName ?? "insider"} bought ${fmtUsd(Number(e.valueUsd))} on ${e.date}; ` +
  `company also flagged by ${e.otherRule} (${e.otherSource})`,
);

// ---------- pure rule logic ----------

export interface InsiderBuy {
  accession: string;
  txnIndex: number;
  ticker: string | null;
  issuerName: string | null;
  insiderName: string | null;
  insiderRole: string | null;
  transactionDate: string | null;
  value: number | null;
}

/** ≥N distinct insiders buying the same ticker inside a trailing window. */
export function clusterBuySignals(
  buys: InsiderBuy[],
  opts: { windowEnd: string; windowDays: number; minInsiders: number },
): SignalInput[] {
  const windowStart = shiftDate(opts.windowEnd, -opts.windowDays);
  const byTicker = new Map<string, InsiderBuy[]>();
  for (const buy of buys) {
    if (!buy.ticker || !buy.insiderName || !buy.transactionDate) continue;
    if (buy.transactionDate < windowStart || buy.transactionDate > opts.windowEnd) continue;
    const list = byTicker.get(buy.ticker) ?? [];
    list.push(buy);
    byTicker.set(buy.ticker, list);
  }

  const signals: SignalInput[] = [];
  for (const [ticker, group] of byTicker) {
    const insiders = [...new Set(group.map((buy) => buy.insiderName!))];
    if (insiders.length < opts.minInsiders) continue;
    const totalUsd = group.reduce((sum, buy) => sum + (buy.value ?? 0), 0);
    if (totalUsd < CLUSTER_MIN_TOTAL_USD) continue;
    const lastDate = group.map((buy) => buy.transactionDate!).sort().at(-1)!;
    signals.push({
      source: SOURCE,
      rule: "insiders.cluster-buys",
      dedupeKey: `${ticker}|${lastDate}`,
      company: group[0]!.issuerName ?? undefined,
      ticker,
      severity: insiders.length >= 3 || totalUsd >= 1_000_000 ? 3 : 2,
      evidence: {
        insiderCount: insiders.length,
        insiders: insiders.slice(0, 6),
        totalUsd,
        windowDays: opts.windowDays,
        lastDate,
      },
    });
  }
  return signals;
}

/** Open-market buy at/above the floor by a top executive. */
export function bigExecBuySignals(buys: InsiderBuy[], minUsd: number): SignalInput[] {
  return buys
    .filter(
      (buy) =>
        buy.value !== null &&
        buy.value >= minUsd &&
        buy.insiderRole !== null &&
        EXEC_ROLE.test(buy.insiderRole),
    )
    .map((buy) => ({
      source: SOURCE,
      rule: "insiders.big-exec-buy",
      dedupeKey: `${buy.accession}|${buy.txnIndex}`,
      company: buy.issuerName ?? undefined,
      ticker: buy.ticker ?? undefined,
      severity: buy.value! >= 1_000_000 ? 3 : 2,
      evidence: {
        insiderName: buy.insiderName,
        role: buy.insiderRole,
        valueUsd: buy.value,
        shares: null,
        date: buy.transactionDate,
      },
    }));
}

/**
 * Insider buy at a company independently flagged by another source recently.
 * Join semantics shared via crossSource.ts (ticker first, conservative name fallback).
 */
export function crossSourceBuySignals(
  buys: InsiderBuy[],
  others: OtherSignalRef[],
  minUsd: number,
): SignalInput[] {
  const index = buildSignalIndex(others);
  return buys.flatMap((buy) => {
    if (buy.value === null || buy.value < minUsd) return [];
    const match = matchSignal(index, buy.ticker, buy.issuerName);
    if (!match) return [];
    return [
      {
        source: SOURCE,
        rule: "insiders.cross-source-buy",
        dedupeKey: `${buy.accession}|${buy.txnIndex}`,
        company: buy.issuerName ?? undefined,
        ticker: buy.ticker ?? undefined,
        severity: 3,
        evidence: {
          insiderName: buy.insiderName,
          valueUsd: buy.value,
          date: buy.transactionDate,
          otherSource: match.source,
          otherRule: match.rule,
        },
      },
    ];
  });
}

// ---------- SQL wrappers ----------

function persist(ctx: RuleContext, signals: SignalInput[]): number {
  return signals.filter((signal) => insertSignal(ctx.db, signal)).length;
}

function loadBuys(ctx: RuleContext): InsiderBuy[] {
  return ctx.db
    .prepare(
      `SELECT accession, txn_index txnIndex, ticker, issuer_name issuerName,
              insider_name insiderName, insider_role insiderRole,
              transaction_date transactionDate, value
       FROM insider_trades WHERE transaction_code = 'P'`,
    )
    .all() as InsiderBuy[];
}

function latestBuyDate(ctx: RuleContext): string | null {
  const row = ctx.db
    .prepare(
      "SELECT MAX(transaction_date) hi FROM insider_trades WHERE transaction_code = 'P'",
    )
    .get() as { hi: string | null };
  return row.hi;
}

const clusterBuyRule: Rule = {
  name: "insiders.cluster-buys",
  run(ctx) {
    const windowEnd = latestBuyDate(ctx);
    if (!windowEnd) return 0;
    return persist(
      ctx,
      clusterBuySignals(loadBuys(ctx), {
        windowEnd,
        windowDays: CLUSTER_WINDOW_DAYS,
        minInsiders: CLUSTER_MIN_INSIDERS,
      }),
    );
  },
};

const bigExecBuyRule: Rule = {
  name: "insiders.big-exec-buy",
  run(ctx) {
    return persist(ctx, bigExecBuySignals(loadBuys(ctx), ctx.config.INSIDER_BIG_BUY_USD));
  },
};

const crossSourceBuyRule: Rule = {
  name: "insiders.cross-source-buy",
  run(ctx) {
    const others = ctx.db
      .prepare(
        `SELECT source, rule, company, ticker FROM signals
         WHERE source != ? AND created_at >= datetime('now', ?)`,
      )
      .all(SOURCE, `-${CROSS_SOURCE_SIGNAL_AGE_DAYS} days`) as OtherSignalRef[];
    return persist(
      ctx,
      crossSourceBuySignals(loadBuys(ctx), others, CROSS_SOURCE_MIN_BUY_USD),
    );
  },
};

export const insiderRules: Rule[] = [clusterBuyRule, bigExecBuyRule, crossSourceBuyRule];
