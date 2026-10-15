import type { Db } from "../db/index.js";
import { CONTENT_TIER_ORDER, TIER_ORDER, TIER_SPECS, tierFor, type Tier } from "./tiers.js";

export interface SignalRow {
  id: number;
  source: string;
  rule: string;
  company: string | null;
  ticker: string | null;
  severity: number;
  evidence: string;
  created_at: string;
}

export function unreportedSignals(db: Db): SignalRow[] {
  return db
    .prepare(
      `SELECT id, source, rule, company, ticker, severity, evidence, created_at
       FROM signals WHERE reported_at IS NULL
       ORDER BY severity DESC, id`,
    )
    .all() as SignalRow[];
}

export function markSignalsReported(db: Db, ids: number[]): void {
  const mark = db.prepare("UPDATE signals SET reported_at = datetime('now') WHERE id = ?");
  const all = db.transaction((signalIds: number[]) => {
    for (const id of signalIds) mark.run(id);
  });
  all(ids);
}

export function fetchStateLines(db: Db): string[] {
  const rows = db
    .prepare("SELECT source, watermark, last_run_at FROM fetch_state ORDER BY source")
    .all() as { source: string; watermark: string | null; last_run_at: string | null }[];
  return rows.map(
    (row) => `${row.source} → ${row.watermark ?? "?"} (fetched ${row.last_run_at ?? "?"})`,
  );
}

export const MAX_LINES_PER_RULE = 15;

export function fmtUsd(value: number): string {
  // Callers do fmtUsd(Number(e.field)) on evidence that may lack the field —
  // "$?" is honest, "$NaN" is the bug that shipped in report № 1.
  if (!Number.isFinite(value)) return "$?";
  if (Math.abs(value) >= 1e9) return `$${(value / 1e9).toFixed(2)}B`;
  if (Math.abs(value) >= 1e6) return `$${(value / 1e6).toFixed(1)}M`;
  return `$${Math.round(value).toLocaleString("en-US")}`;
}

export type Evidence = Record<string, unknown>;
export type EvidenceFormatter = (evidence: Evidence) => string;

// Per-rule one-line evidence renderers. Rule modules register their own via
// registerEvidenceFormatter at import time; anything unregistered falls back to
// compact JSON — the digest never needs editing for a new rule.
const evidenceFormatters: Record<string, EvidenceFormatter> = {};

export function registerEvidenceFormatter(rule: string, formatter: EvidenceFormatter): void {
  evidenceFormatters[rule] = formatter;
}

/**
 * Formatters interpolate evidence fields directly (`${e.awardId}`), so a signal
 * written by an older rule version renders "undefined"/"NaN" into the report —
 * this shipped once already. Rather than trusting sixteen formatters to each
 * stay defensive, the report layer enforces the invariant once, here.
 *
 * Only applied to formatter output: the raw-JSON fallback below may legitimately
 * contain `null`, and JSON.stringify never emits `undefined` or `NaN` anyway.
 */
const PLACEHOLDER_TOKENS = /\b(?:undefined|NaN|null|Invalid Date)\b/g;

export function formatEvidence(rule: string, evidenceJson: string): string {
  const evidence = parseEvidence(evidenceJson);
  if (!evidence) return evidenceJson;
  const formatter = evidenceFormatters[rule];
  if (!formatter) return JSON.stringify(evidence);
  try {
    return formatter(evidence).replace(PLACEHOLDER_TOKENS, "?");
  } catch {
    // A formatter reaching into a field that isn't there must not take down the
    // whole digest — fall back to the raw evidence for that one line.
    return JSON.stringify(evidence);
  }
}

function parseEvidence(evidenceJson: string): Evidence | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(evidenceJson);
  } catch {
    return null;
  }
  // JSON.parse happily yields null / 3 / "x"; only an object has fields to read.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  return parsed as Evidence;
}

// ---------- signal age ----------

/**
 * Evidence keys checked, in order, for "when did this actually happen". Evidence
 * shapes vary per rule and older signals may lack date fields entirely, so this
 * is best-effort: anything unparseable simply yields no age rather than "NaN".
 */
const AGE_KEYS = [
  "actionDate",
  "date",
  "lastDate",
  "transactionDate",
  "firstSeen",
  "newestDate",
  "filingDate",
  "dtPosted",
  "periodEnd",
  "period",
  "asOf",
];

/** Epoch ms for a leading YYYY-MM-DD, or null for anything else. */
function parseIsoDay(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Whole days between the date inside `evidence` and `asOfIso`, or null when the
 * evidence carries no usable date. Never returns NaN/Infinity — callers render
 * the result directly.
 */
export function evidenceAgeDays(evidence: Evidence, asOfIso: string): number | null {
  const asOf = parseIsoDay(asOfIso);
  if (asOf === null) return null;
  // Known keys first, then any other date-ish key so new rules get age for free.
  const extras = Object.keys(evidence).filter(
    (key) => !AGE_KEYS.includes(key) && /date|period|seen|asof/i.test(key),
  );
  for (const key of [...AGE_KEYS, ...extras]) {
    const when = parseIsoDay(evidence[key]);
    if (when === null) continue;
    const days = Math.floor((asOf - when) / 86_400_000);
    // Future-dated evidence is a data error, not an age — keep looking.
    if (!Number.isFinite(days) || days < 0) continue;
    return days;
  }
  return null;
}

/** Trailing " · 23d old" for a digest line, or "" when age is unknown. */
export function formatAge(evidenceJson: string, asOfIso: string): string {
  const evidence = parseEvidence(evidenceJson);
  if (!evidence) return "";
  const days = evidenceAgeDays(evidence, asOfIso);
  if (days === null) return "";
  return days === 0 ? " · today" : ` · ${days}d old`;
}

interface RuleGroup {
  rule: string;
  signals: SignalRow[];
}

/** Rule groups per tier, each tier's groups ordered by top severity then name. */
function groupByTier(signals: SignalRow[]): Map<Tier, RuleGroup[]> {
  const byRule = new Map<string, SignalRow[]>();
  for (const signal of signals) {
    const group = byRule.get(signal.rule) ?? [];
    group.push(signal);
    byRule.set(signal.rule, group);
  }

  const byTier = new Map<Tier, RuleGroup[]>();
  for (const [rule, group] of byRule) {
    const tier = tierFor(rule);
    const groups = byTier.get(tier) ?? [];
    groups.push({ rule, signals: group });
    byTier.set(tier, groups);
  }
  for (const groups of byTier.values()) {
    groups.sort(
      (a, b) =>
        Math.max(...b.signals.map((s) => s.severity)) -
          Math.max(...a.signals.map((s) => s.severity)) || a.rule.localeCompare(b.rule),
    );
  }
  return byTier;
}

function renderGroup(group: RuleGroup, generatedAt: string): string[] {
  const lines = [`### ${group.rule} (${group.signals.length})`, ""];
  // Signals arrive pre-sorted by severity; cap the listing so one chatty rule
  // can't swamp the digest (full detail stays queryable in the signals table).
  const shown = group.signals.slice(0, MAX_LINES_PER_RULE);
  for (const signal of shown) {
    // Pipeline-health signals have no subject company — don't print a bare "**?**".
    const who = signal.ticker
      ? `**${signal.company ?? "?"} [${signal.ticker}]** — `
      : signal.company
        ? `**${signal.company}** — `
        : "";
    lines.push(
      `- [sev ${signal.severity}] ${who}${formatEvidence(group.rule, signal.evidence)}` +
        formatAge(signal.evidence, generatedAt),
    );
  }
  if (group.signals.length > shown.length) {
    lines.push(`- …and ${group.signals.length - shown.length} more (see signals table)`);
  }
  lines.push("");
  return lines;
}

function renderTier(tier: Tier, groups: RuleGroup[], generatedAt: string): string[] {
  const spec = TIER_SPECS[tier];
  const count = groups.reduce((sum, group) => sum + group.signals.length, 0);
  const lines = [`## ${spec.heading} (${count})`, "", `_${spec.note}_`, ""];
  for (const group of groups) lines.push(...renderGroup(group, generatedAt));
  return lines;
}

export function buildDigest(
  signals: SignalRow[],
  meta: { generatedAt: string; freshness: string[] },
): string {
  const lines: string[] = [`# Alt-data digest — ${meta.generatedAt}`, ""];
  if (meta.freshness.length > 0) {
    lines.push(`Data freshness: ${meta.freshness.join("; ")}`, "");
  }

  if (signals.length === 0) {
    lines.push("No new signals since the last report.", "");
  } else {
    const byTier = groupByTier(signals);
    const tally = TIER_ORDER.filter((tier) => byTier.has(tier))
      .map((tier) => {
        const count = byTier.get(tier)!.reduce((sum, group) => sum + group.signals.length, 0);
        return `${tier} ${count}`;
      })
      .join(" · ");
    lines.push(`${signals.length} new signal(s) — ${tally}`, "");

    // Pipeline health goes first and stays loud: a stale source invalidates
    // everything under it, so it must never be buried below the findings.
    const metaGroups = byTier.get("meta");
    if (metaGroups) lines.push(...renderTier("meta", metaGroups, meta.generatedAt));

    // Findings, most-useful tier first — usefulness, not dollar magnitude.
    for (const tier of CONTENT_TIER_ORDER) {
      const groups = byTier.get(tier);
      if (groups) lines.push(...renderTier(tier, groups, meta.generatedAt));
    }
  }

  lines.push("_Informational research on public data — not investment advice._", "");
  return lines.join("\n");
}
