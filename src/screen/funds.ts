import { insertSignal, type SignalInput } from "../db/index.js";
import { fmtUsd, registerEvidenceFormatter } from "../report/digest.js";
import { buildSignalIndex, matchSignal, type OtherSignalRef } from "./crossSource.js";
import type { Rule, RuleContext } from "./index.js";

const SOURCE = "edgar-13f";

export const BIG_NEW_POSITION_USD = 250_000_000;
export const INCREASE_RATIO = 1.5;
export const CROSS_SOURCE_SIGNAL_AGE_DAYS = 45; // 13F is quarterly; allow a wider join window

registerEvidenceFormatter("13f.big-new-position", (e) =>
  `${e.fund} opened a ${fmtUsd(Number(e.valueUsd))} position in ${e.issuer} (${e.period})`,
);
registerEvidenceFormatter("13f.cross-source-position", (e) =>
  `${e.fund} ${e.change === "new" ? "opened a position in" : `grew its position ${e.ratio}x in`} ` +
  `${e.issuer} (${fmtUsd(Number(e.valueUsd))}, ${e.period}); ` +
  `company also flagged by ${e.otherRule} (${e.otherSource})`,
);

// ---------- pure rule logic ----------

export interface HoldingLike {
  fund: string;
  cik: string;
  period: string;
  issuer: string;
  cusip: string;
  valueUsd: number | null;
  shares: number | null;
}

export interface PositionChange {
  fund: string;
  cik: string;
  period: string;
  issuer: string;
  cusip: string;
  valueUsd: number | null;
  change: "new" | "increase";
  ratio: number | null;
}

/** Diff a fund's latest quarter against the prior one. Pure. */
export function diffPositions(latest: HoldingLike[], prior: HoldingLike[]): PositionChange[] {
  const priorByCusip = new Map(prior.map((holding) => [holding.cusip, holding]));
  const changes: PositionChange[] = [];
  for (const holding of latest) {
    const before = priorByCusip.get(holding.cusip);
    if (!before) {
      changes.push({ ...pick(holding), change: "new", ratio: null });
    } else if (
      holding.shares !== null &&
      before.shares !== null &&
      before.shares > 0 &&
      holding.shares >= before.shares * INCREASE_RATIO
    ) {
      changes.push({
        ...pick(holding),
        change: "increase",
        ratio: Number((holding.shares / before.shares).toFixed(1)),
      });
    }
  }
  return changes;

  function pick(holding: HoldingLike) {
    return {
      fund: holding.fund,
      cik: holding.cik,
      period: holding.period,
      issuer: holding.issuer,
      cusip: holding.cusip,
      valueUsd: holding.valueUsd,
    };
  }
}

/** Brand-new positions large enough to be notable on their own. */
export function bigNewPositionSignals(changes: PositionChange[], minUsd: number): SignalInput[] {
  return changes
    .filter((change) => change.change === "new" && (change.valueUsd ?? 0) >= minUsd)
    .map((change) => ({
      source: SOURCE,
      rule: "13f.big-new-position",
      dedupeKey: `${change.cik}|${change.period}|${change.cusip}`,
      company: change.issuer,
      severity: (change.valueUsd ?? 0) >= 1_000_000_000 ? 3 : 2,
      evidence: {
        fund: change.fund,
        issuer: change.issuer,
        valueUsd: change.valueUsd,
        period: change.period,
      },
    }));
}

/** New/grown positions in companies another source already flagged. */
export function crossSourcePositionSignals(
  changes: PositionChange[],
  others: OtherSignalRef[],
): SignalInput[] {
  const index = buildSignalIndex(others);
  return changes.flatMap((change) => {
    const match = matchSignal(index, null, change.issuer);
    if (!match) return [];
    return [
      {
        source: SOURCE,
        rule: "13f.cross-source-position",
        dedupeKey: `${change.cik}|${change.period}|${change.cusip}`,
        company: change.issuer,
        severity: 2,
        evidence: {
          fund: change.fund,
          issuer: change.issuer,
          valueUsd: change.valueUsd,
          period: change.period,
          change: change.change,
          ratio: change.ratio,
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

function loadAllChanges(ctx: RuleContext): PositionChange[] {
  const funds = ctx.db
    .prepare("SELECT DISTINCT cik FROM fund_holdings")
    .all() as { cik: string }[];
  const changes: PositionChange[] = [];
  const holdingsFor = ctx.db.prepare(
    `SELECT fund, cik, period, issuer, cusip, value_usd valueUsd, shares
     FROM fund_holdings WHERE cik = ? AND period = ?`,
  );
  for (const { cik } of funds) {
    const periods = ctx.db
      .prepare("SELECT DISTINCT period FROM fund_holdings WHERE cik = ? ORDER BY period DESC LIMIT 2")
      .all(cik) as { period: string }[];
    if (periods.length < 2) continue; // need a prior quarter to diff against
    const latest = holdingsFor.all(cik, periods[0]!.period) as HoldingLike[];
    const prior = holdingsFor.all(cik, periods[1]!.period) as HoldingLike[];
    changes.push(...diffPositions(latest, prior));
  }
  return changes;
}

const bigNewPositionRule: Rule = {
  name: "13f.big-new-position",
  run(ctx) {
    return persist(ctx, bigNewPositionSignals(loadAllChanges(ctx), BIG_NEW_POSITION_USD));
  },
};

const crossSourcePositionRule: Rule = {
  name: "13f.cross-source-position",
  run(ctx) {
    const others = ctx.db
      .prepare(
        `SELECT source, rule, company, ticker FROM signals
         WHERE source != ? AND rule NOT LIKE 'meta.%'
           AND created_at >= datetime('now', ?)`,
      )
      .all(SOURCE, `-${CROSS_SOURCE_SIGNAL_AGE_DAYS} days`) as OtherSignalRef[];
    return persist(ctx, crossSourcePositionSignals(loadAllChanges(ctx), others));
  },
};

export const fundRules: Rule[] = [bigNewPositionRule, crossSourcePositionRule];
