import { insertSignal, type SignalInput } from "../db/index.js";
import { fmtUsd, registerEvidenceFormatter } from "../report/digest.js";
import { shiftDate } from "../util/dates.js";
import type { Rule, RuleContext } from "./index.js";
import { applyTickerPolicy, createTickerResolver } from "./tickerPolicy.js";

const SOURCE = "usaspending";

registerEvidenceFormatter("contracts.mega-award", (e) =>
  `${fmtUsd(Number(e.amount))} — ${e.agency ?? "unknown agency"} — ` +
  `${String(e.description ?? "").trim() || "no description"} ` +
  `(award ${e.awardId}, ${e.actionDate})`,
);
registerEvidenceFormatter("contracts.new-large-recipient", (e) =>
  `first seen ${e.firstSeen}: ${e.awardCount} award(s) totaling ${fmtUsd(Number(e.totalUsd))}, ` +
  `largest ${fmtUsd(Number(e.largestAwardUsd))}` +
  // Evidence written by older rule versions may lack fields — degrade, don't print "undefined".
  (e.baselineSince ? ` (caveat: our data only goes back to ${e.baselineSince})` : ""),
);
registerEvidenceFormatter("contracts.spend-spike", (e) =>
  `${fmtUsd(Number(e.currentWindowUsd))} in last ${e.windowDays}d vs ` +
  `${fmtUsd(Number(e.priorWindowUsd))} prior — ${e.ratio}x`,
);

// Rule parameters. User-tunable ones live in config (see docs/DECISIONS.md D2);
// these shape rule mechanics and are exported so tests pin them down.
export const NEW_RECIPIENT_WINDOW_DAYS = 14;
export const NEW_RECIPIENT_MIN_TOTAL_USD = 20_000_000;
export const SPIKE_WINDOW_DAYS = 90;
export const SPIKE_RATIO = 3;
export const SPIKE_MIN_CURRENT_USD = 20_000_000;
export const SPIKE_MIN_PRIOR_USD = 5_000_000;

// ---------- pure rule logic (unit-tested on fixtures) ----------

export interface MegaAwardRow {
  naturalKey: string;
  awardId: string;
  recipient: string;
  amount: number;
  actionDate: string;
  awardingAgency: string | null;
  description: string | null;
}

/** Single contract actions large enough to be notable on their own. */
export function megaAwardSignals(rows: MegaAwardRow[], megaUsd: number): SignalInput[] {
  return rows
    .filter((row) => row.amount >= megaUsd)
    .map((row) => ({
      source: SOURCE,
      rule: "contracts.mega-award",
      dedupeKey: row.naturalKey,
      company: row.recipient,
      severity: row.amount >= 1_000_000_000 ? 3 : 2,
      evidence: {
        awardId: row.awardId,
        amount: row.amount,
        actionDate: row.actionDate,
        agency: row.awardingAgency,
        description: row.description?.slice(0, 200) ?? null,
      },
    }));
}

export interface RecipientAggRow {
  recipient: string;
  firstSeen: string;
  total: number;
  awardCount: number;
  topAmount: number;
}

/**
 * Recipients whose first-ever award in our data landed inside the recent window,
 * with meaningful total volume. Only valid when the db has history predating the
 * window (`baselineStart`), otherwise every recipient looks "new".
 */
export function newRecipientSignals(
  rows: RecipientAggRow[],
  opts: { windowStart: string; dbFirstDate: string; minTotal: number },
): SignalInput[] {
  if (opts.dbFirstDate >= opts.windowStart) return [];
  return rows
    .filter((row) => row.firstSeen >= opts.windowStart && row.total >= opts.minTotal)
    .map((row) => ({
      source: SOURCE,
      rule: "contracts.new-large-recipient",
      dedupeKey: `${row.recipient}|${row.firstSeen}`,
      company: row.recipient,
      severity: 2,
      evidence: {
        firstSeen: row.firstSeen,
        totalUsd: row.total,
        awardCount: row.awardCount,
        largestAwardUsd: row.topAmount,
        windowDays: NEW_RECIPIENT_WINDOW_DAYS,
        // "New" = first appearance in OUR data; shallow history weakens the claim.
        baselineSince: opts.dbFirstDate,
      },
    }));
}

export interface SpendWindowRow {
  recipient: string;
  currentUsd: number;
  priorUsd: number;
}

/** Recipients whose trailing window total jumped vs the preceding window. */
export function spendSpikeSignals(
  rows: SpendWindowRow[],
  opts: { ratio: number; minCurrent: number; minPrior: number; bucket: string },
): SignalInput[] {
  return rows
    .filter(
      (row) =>
        row.priorUsd >= opts.minPrior &&
        row.currentUsd >= opts.minCurrent &&
        row.currentUsd >= row.priorUsd * opts.ratio,
    )
    .map((row) => ({
      source: SOURCE,
      rule: "contracts.spend-spike",
      dedupeKey: `${row.recipient}|${opts.bucket}`,
      company: row.recipient,
      severity: 2,
      evidence: {
        currentWindowUsd: row.currentUsd,
        priorWindowUsd: row.priorUsd,
        ratio: Number((row.currentUsd / row.priorUsd).toFixed(1)),
        windowDays: SPIKE_WINDOW_DAYS,
      },
    }));
}

// ---------- SQL wrappers ----------

/**
 * One resolver per call, and persist() is called once per rule run — so the
 * overrides file is read once per rule, not once per candidate row.
 */
function persist(ctx: RuleContext, signals: SignalInput[]): number {
  const screened = applyTickerPolicy(signals, createTickerResolver(ctx.db));
  return screened.filter((signal) => insertSignal(ctx.db, signal)).length;
}

function dataBounds(ctx: RuleContext): { lo: string; hi: string } | null {
  const row = ctx.db
    .prepare("SELECT MIN(action_date) lo, MAX(action_date) hi FROM contracts")
    .get() as { lo: string | null; hi: string | null };
  return row.lo && row.hi ? { lo: row.lo, hi: row.hi } : null;
}

const megaAwardRule: Rule = {
  name: "contracts.mega-award",
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT natural_key naturalKey, award_id awardId, recipient, amount,
                action_date actionDate, awarding_agency awardingAgency, description
         FROM contracts WHERE amount >= ?`,
      )
      .all(ctx.config.MEGA_CONTRACT_USD) as MegaAwardRow[];
    return persist(ctx, megaAwardSignals(rows, ctx.config.MEGA_CONTRACT_USD));
  },
};

const newRecipientRule: Rule = {
  name: "contracts.new-large-recipient",
  run(ctx) {
    const bounds = dataBounds(ctx);
    if (!bounds) return 0;
    const windowStart = shiftDate(bounds.hi, -NEW_RECIPIENT_WINDOW_DAYS);
    const rows = ctx.db
      .prepare(
        `SELECT recipient, MIN(action_date) firstSeen, SUM(amount) total,
                COUNT(*) awardCount, MAX(amount) topAmount
         FROM contracts GROUP BY recipient`,
      )
      .all() as RecipientAggRow[];
    return persist(
      ctx,
      newRecipientSignals(rows, {
        windowStart,
        dbFirstDate: bounds.lo,
        minTotal: NEW_RECIPIENT_MIN_TOTAL_USD,
      }),
    );
  },
};

const spendSpikeRule: Rule = {
  name: "contracts.spend-spike",
  run(ctx) {
    const bounds = dataBounds(ctx);
    if (!bounds) return 0;
    const currentStart = shiftDate(bounds.hi, -SPIKE_WINDOW_DAYS);
    const priorStart = shiftDate(bounds.hi, -2 * SPIKE_WINDOW_DAYS);
    // Without a full prior window of history the ratio is meaningless.
    if (bounds.lo > priorStart) return 0;
    const rows = ctx.db
      .prepare(
        `SELECT recipient,
                SUM(CASE WHEN action_date >= @currentStart THEN amount ELSE 0 END) currentUsd,
                SUM(CASE WHEN action_date >= @priorStart AND action_date < @currentStart
                    THEN amount ELSE 0 END) priorUsd
         FROM contracts GROUP BY recipient`,
      )
      .all({ currentStart, priorStart }) as SpendWindowRow[];
    return persist(
      ctx,
      spendSpikeSignals(rows, {
        ratio: SPIKE_RATIO,
        minCurrent: SPIKE_MIN_CURRENT_USD,
        minPrior: SPIKE_MIN_PRIOR_USD,
        bucket: bounds.hi.slice(0, 7),
      }),
    );
  },
};

export const contractRules: Rule[] = [megaAwardRule, newRecipientRule, spendSpikeRule];
