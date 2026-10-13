import type { Db } from "../db/index.js";

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

const MAX_LINES_PER_RULE = 15;

export function fmtUsd(value: number): string {
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

export function formatEvidence(rule: string, evidenceJson: string): string {
  let evidence: Evidence;
  try {
    evidence = JSON.parse(evidenceJson) as Evidence;
  } catch {
    return evidenceJson;
  }
  const formatter = evidenceFormatters[rule];
  return formatter ? formatter(evidence) : JSON.stringify(evidence);
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
    const byRule = new Map<string, SignalRow[]>();
    for (const signal of signals) {
      const group = byRule.get(signal.rule) ?? [];
      group.push(signal);
      byRule.set(signal.rule, group);
    }
    const summary = [...byRule.entries()]
      .map(([rule, group]) => `${rule} ${group.length}`)
      .join(", ");
    lines.push(`${signals.length} new signal(s): ${summary}`, "");

    for (const [rule, group] of byRule) {
      lines.push(`## ${rule} (${group.length})`, "");
      // Groups are pre-sorted by severity; cap the listing so one chatty rule
      // can't swamp the digest (full detail stays queryable in the signals table).
      const shown = group.slice(0, MAX_LINES_PER_RULE);
      for (const signal of shown) {
        const who = signal.ticker
          ? `${signal.company ?? "?"} [${signal.ticker}]`
          : (signal.company ?? "?");
        lines.push(`- [sev ${signal.severity}] **${who}** — ${formatEvidence(rule, signal.evidence)}`);
      }
      if (group.length > shown.length) {
        lines.push(`- …and ${group.length - shown.length} more (see signals table)`);
      }
      lines.push("");
    }
  }

  lines.push("_Informational research on public data — not investment advice._", "");
  return lines.join("\n");
}
