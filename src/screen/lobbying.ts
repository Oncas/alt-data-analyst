import { insertSignal, type SignalInput } from "../db/index.js";
import { fmtUsd, registerEvidenceFormatter } from "../report/digest.js";
import type { Rule, RuleContext } from "./index.js";
import { applyTickerPolicy, createTickerResolver } from "./tickerPolicy.js";

const SOURCE = "lda";

export const QUARTERLY_SPIKE_RATIO = 2;
export const QUARTERLY_SPIKE_MIN_USD = 100_000;
/** Quarters of history (beyond the latest) required before the spike rule speaks. */
export const QUARTERLY_SPIKE_MIN_PRIOR_QUARTERS = 2;

registerEvidenceFormatter("lobbying.watched-issue", (e) =>
  `${fmtUsd(Number(e.amountUsd))} in ${e.period ?? "?"} ${e.year ?? ""} via ${e.registrant ?? "?"} — ` +
  `watched issue(s): ${Array.isArray(e.matchedCodes) ? e.matchedCodes.join(", ") : "?"}`,
);
registerEvidenceFormatter("lobbying.new-registration", (e) =>
  `new lobbying registration via ${e.registrant ?? "?"}` +
  (e.clientDescription ? ` — client: ${e.clientDescription}` : ""),
);
registerEvidenceFormatter("lobbying.quarterly-spike", (e) =>
  `${fmtUsd(Number(e.currentUsd))} in ${e.quarter} vs ${fmtUsd(Number(e.priorAvgUsd))} ` +
  `avg over ${e.priorQuarters} prior quarter(s) — ${e.ratio}x`,
);

// ---------- pure rule logic ----------

export interface LobbyFilingLike {
  filingUuid: string;
  client: string | null;
  registrant: string | null;
  clientDescription?: string | null;
  filingType: string | null;
  filingYear: number | null;
  filingPeriod: string | null;
  amountUsd: number | null; // income ?? expenses
  issueCodes: string[];
}

/** Large filings touching issue codes the owner watches. */
export function watchedIssueSignals(
  rows: LobbyFilingLike[],
  opts: { watch: ReadonlySet<string>; minUsd: number },
): SignalInput[] {
  return rows.flatMap((row) => {
    const matched = row.issueCodes.filter((code) => opts.watch.has(code));
    if (matched.length === 0 || row.amountUsd === null || row.amountUsd < opts.minUsd) {
      return [];
    }
    return [
      {
        source: SOURCE,
        rule: "lobbying.watched-issue",
        dedupeKey: row.filingUuid,
        company: row.client ?? undefined,
        severity: row.amountUsd >= 1_000_000 ? 3 : 2,
        evidence: {
          amountUsd: row.amountUsd,
          registrant: row.registrant,
          matchedCodes: matched,
          year: row.filingYear,
          period: row.filingPeriod,
        },
      },
    ];
  });
}

/** Registration filings (RR) — a client hiring lobbyists for the first time. */
export function newRegistrationSignals(rows: LobbyFilingLike[]): SignalInput[] {
  return rows
    .filter((row) => row.filingType === "RR" && row.client)
    .map((row) => ({
      source: SOURCE,
      rule: "lobbying.new-registration",
      dedupeKey: row.filingUuid,
      company: row.client ?? undefined,
      severity: 1,
      evidence: {
        registrant: row.registrant,
        clientDescription: row.clientDescription ?? null,
        year: row.filingYear,
        period: row.filingPeriod,
      },
    }));
}

export interface ClientQuarterSeries {
  client: string;
  /** Chronologically ascending, e.g. [{ quarter: "2025Q3", usd: 80000 }, ...] */
  quarters: { quarter: string; usd: number }[];
}

/** Latest quarter vs the average of prior quarters, per client. */
export function quarterlySpikeSignals(
  series: ClientQuarterSeries[],
  opts: { ratio: number; minCurrent: number; minPriorQuarters: number },
): SignalInput[] {
  return series.flatMap((entry) => {
    if (entry.quarters.length < opts.minPriorQuarters + 1) return [];
    const current = entry.quarters[entry.quarters.length - 1]!;
    const prior = entry.quarters.slice(0, -1);
    const priorAvg = prior.reduce((sum, q) => sum + q.usd, 0) / prior.length;
    if (priorAvg <= 0 || current.usd < opts.minCurrent) return [];
    if (current.usd < priorAvg * opts.ratio) return [];
    return [
      {
        source: SOURCE,
        rule: "lobbying.quarterly-spike",
        dedupeKey: `${entry.client}|${current.quarter}`,
        company: entry.client,
        severity: 2,
        evidence: {
          quarter: current.quarter,
          currentUsd: current.usd,
          priorAvgUsd: Math.round(priorAvg),
          priorQuarters: prior.length,
          ratio: Number((current.usd / priorAvg).toFixed(1)),
        },
      },
    ];
  });
}

// ---------- SQL wrappers ----------

const PERIOD_ORDER: Record<string, number> = {
  first_quarter: 1,
  second_quarter: 2,
  third_quarter: 3,
  fourth_quarter: 4,
  mid_year: 2,
  year_end: 4,
};

/**
 * One resolver per call, and persist() is called once per rule run — so the
 * overrides file is read once per rule, not once per candidate row.
 */
function persist(ctx: RuleContext, signals: SignalInput[]): number {
  const screened = applyTickerPolicy(signals, createTickerResolver(ctx.db));
  return screened.filter((signal) => insertSignal(ctx.db, signal)).length;
}

function loadFilings(ctx: RuleContext): LobbyFilingLike[] {
  const rows = ctx.db
    .prepare(
      `SELECT filing_uuid filingUuid, client, registrant,
              client_description clientDescription, filing_type filingType,
              filing_year filingYear, filing_period filingPeriod,
              COALESCE(income, expenses) amountUsd, issue_codes issueCodesJson
       FROM lobbying_filings`,
    )
    .all() as (Omit<LobbyFilingLike, "issueCodes"> & { issueCodesJson: string })[];
  return rows.map(({ issueCodesJson, ...rest }) => {
    let issueCodes: string[] = [];
    try {
      const parsed: unknown = JSON.parse(issueCodesJson);
      if (Array.isArray(parsed)) issueCodes = parsed.filter((c): c is string => typeof c === "string");
    } catch {
      // tolerate malformed stored JSON; treat as no codes
    }
    return { ...rest, issueCodes };
  });
}

const watchedIssueRule: Rule = {
  name: "lobbying.watched-issue",
  run(ctx) {
    const watch = new Set(
      ctx.config.WATCH_ISSUE_CODES.split(",")
        .map((code) => code.trim().toUpperCase())
        .filter(Boolean),
    );
    return persist(
      ctx,
      watchedIssueSignals(loadFilings(ctx), { watch, minUsd: ctx.config.LOBBY_MIN_USD }),
    );
  },
};

const newRegistrationRule: Rule = {
  name: "lobbying.new-registration",
  run(ctx) {
    return persist(ctx, newRegistrationSignals(loadFilings(ctx)));
  },
};

const quarterlySpikeRule: Rule = {
  name: "lobbying.quarterly-spike",
  run(ctx) {
    const rows = ctx.db
      .prepare(
        `SELECT client, filing_year year, filing_period period,
                SUM(COALESCE(income, 0) + COALESCE(expenses, 0)) usd
         FROM lobbying_filings
         WHERE client IS NOT NULL AND filing_year IS NOT NULL AND filing_period IS NOT NULL
         GROUP BY client, filing_year, filing_period`,
      )
      .all() as { client: string; year: number; period: string; usd: number }[];

    const byClient = new Map<string, { quarter: string; order: number; usd: number }[]>();
    for (const row of rows) {
      const periodIndex = PERIOD_ORDER[row.period];
      if (periodIndex === undefined || row.usd <= 0) continue;
      const list = byClient.get(row.client) ?? [];
      list.push({
        quarter: `${row.year}Q${periodIndex}`,
        order: row.year * 4 + periodIndex,
        usd: row.usd,
      });
      byClient.set(row.client, list);
    }
    const series: ClientQuarterSeries[] = [...byClient.entries()].map(([client, quarters]) => ({
      client,
      quarters: quarters
        .sort((a, b) => a.order - b.order)
        .map(({ quarter, usd }) => ({ quarter, usd })),
    }));

    return persist(
      ctx,
      quarterlySpikeSignals(series, {
        ratio: QUARTERLY_SPIKE_RATIO,
        minCurrent: QUARTERLY_SPIKE_MIN_USD,
        minPriorQuarters: QUARTERLY_SPIKE_MIN_PRIOR_QUARTERS,
      }),
    );
  },
};

export const lobbyingRules: Rule[] = [watchedIssueRule, newRegistrationRule, quarterlySpikeRule];
