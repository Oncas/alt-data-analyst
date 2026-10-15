import type { Db } from "../db/index.js";
import { loadOverrides } from "../enrich/tickers.js";
import { normalizeCompanyName } from "../util/companies.js";
import { fmtUsd } from "./digest.js";

const ROW_LIMIT = 12;

/** Company-name spellings that refer to this ticker (SEC list + overrides, reversed). */
function namesFor(db: Db, symbol: string): Set<string> {
  const names = new Set<string>();
  const listed = db
    .prepare("SELECT normalized_name, title FROM company_tickers WHERE ticker = ?")
    .all(symbol) as { normalized_name: string; title: string }[];
  for (const row of listed) names.add(row.normalized_name);
  for (const [name, ticker] of Object.entries(loadOverrides())) {
    if (ticker === symbol) names.add(name);
  }
  return names;
}

/** Everything the database knows about one ticker, as readable markdown. */
export function tickerView(db: Db, symbolRaw: string): string {
  const symbol = symbolRaw.trim().toUpperCase();
  const names = namesFor(db, symbol);
  const nameList = [...names];
  const lines: string[] = [`# ${symbol} — everything in the local db`, ""];
  if (nameList.length > 0) {
    lines.push(`Known company names: ${nameList.join("; ")}`, "");
  }

  const congress = db
    .prepare(
      `SELECT filer_name, transaction_type, amount_label, transaction_date, filing_date
       FROM congress_trades WHERE ticker = ? ORDER BY transaction_date DESC LIMIT ?`,
    )
    .all(symbol, ROW_LIMIT) as Record<string, string | null>[];
  const congressTotal = (
    db.prepare("SELECT COUNT(*) n FROM congress_trades WHERE ticker = ?").get(symbol) as { n: number }
  ).n;
  lines.push(`## Congress trades (${congressTotal} total, latest ${congress.length})`, "");
  for (const row of congress) {
    lines.push(
      `- ${row.transaction_date} ${row.filer_name}: ${row.transaction_type} ${row.amount_label ?? "?"} (filed ${row.filing_date})`,
    );
  }
  if (congress.length === 0) lines.push("- none");
  lines.push("");

  const insiders = db
    .prepare(
      `SELECT insider_name, insider_role, transaction_code, transaction_date, value
       FROM insider_trades WHERE ticker = ? ORDER BY transaction_date DESC LIMIT ?`,
    )
    .all(symbol, ROW_LIMIT) as Record<string, string | number | null>[];
  lines.push(`## Insider trades (latest ${insiders.length})`, "");
  for (const row of insiders) {
    const value = typeof row.value === "number" ? fmtUsd(row.value) : "?";
    lines.push(
      `- ${row.transaction_date} ${row.insider_name} (${row.insider_role ?? "?"}): ` +
        `${row.transaction_code === "P" ? "BUY" : "SELL"} ${value}`,
    );
  }
  if (insiders.length === 0) lines.push("- none");
  lines.push("");

  const matchByName = (table: string, nameColumn: string, select: string, order: string) => {
    if (nameList.length === 0) return [] as Record<string, unknown>[];
    const rows = db
      .prepare(`SELECT ${select} FROM ${table} ORDER BY ${order} DESC LIMIT 500`)
      .all() as Record<string, unknown>[];
    return rows
      .filter((row) => {
        const name = row[nameColumn];
        return typeof name === "string" && names.has(normalizeCompanyName(name));
      })
      .slice(0, ROW_LIMIT);
  };

  const contracts = matchByName(
    "contracts", "recipient",
    "recipient, amount, action_date, awarding_agency", "action_date",
  );
  lines.push(`## Federal contracts (name-matched, latest ${contracts.length})`, "");
  for (const row of contracts) {
    lines.push(
      `- ${row.action_date}: ${fmtUsd(Number(row.amount ?? 0))} — ${row.awarding_agency}`,
    );
  }
  if (contracts.length === 0) lines.push("- none");
  lines.push("");

  const lobbying = matchByName(
    "lobbying_filings", "client",
    "client, registrant, COALESCE(income, expenses) amt, filing_period, filing_year, dt_posted", "dt_posted",
  );
  lines.push(`## Lobbying filings (name-matched, latest ${lobbying.length})`, "");
  for (const row of lobbying) {
    const amt = row.amt === null ? "n/a" : fmtUsd(Number(row.amt));
    lines.push(`- ${row.filing_year} ${row.filing_period}: ${amt} via ${row.registrant}`);
  }
  if (lobbying.length === 0) lines.push("- none");
  lines.push("");

  const fundRows = (
    db.prepare("SELECT fund, period, issuer, value_usd FROM fund_holdings ORDER BY period DESC").all() as {
      fund: string; period: string; issuer: string; value_usd: number | null;
    }[]
  ).filter((row) => names.has(normalizeCompanyName(row.issuer))).slice(0, ROW_LIMIT);
  lines.push(`## Watchlist fund holdings (name-matched, ${fundRows.length})`, "");
  for (const row of fundRows) {
    lines.push(`- ${row.period} ${row.fund}: ${row.value_usd === null ? "?" : fmtUsd(row.value_usd)}`);
  }
  if (fundRows.length === 0) lines.push("- none");
  lines.push("");

  const signals = db
    .prepare(
      `SELECT rule, severity, created_at, reported_at FROM signals
       WHERE ticker = ? ORDER BY created_at DESC LIMIT ?`,
    )
    .all(symbol, ROW_LIMIT) as Record<string, string | number | null>[];
  lines.push(`## Signals (${signals.length})`, "");
  for (const row of signals) {
    lines.push(
      `- [sev ${row.severity}] ${row.rule} (${String(row.created_at).slice(0, 10)}` +
        `${row.reported_at ? ", reported" : ", unreported"})`,
    );
  }
  if (signals.length === 0) lines.push("- none");
  lines.push("");

  return lines.join("\n");
}
