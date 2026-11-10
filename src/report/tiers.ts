/**
 * Editorial tiering for the digest.
 *
 * Report № 1 ordered sections by dollar magnitude, which put the least useful
 * material first: five of six sections went to contracts/lobbying (7–26% of
 * items map to a tradeable public ticker, and the data averages ~23 days stale)
 * while cross-source correlations (100%) got one line. Tiers fix the ordering.
 *
 * Tiering is an *editorial* judgement about how a signal reads in a report, not
 * a property of the rule that produced it — so it lives here in the report layer
 * rather than being declared inside each rule module. Rule modules stay ignorant
 * of presentation; adding a rule never requires touching this file (see
 * `tierFor` for how unknown rules degrade).
 */

export type Tier = "lead" | "standard" | "confirmation" | "meta";

export interface TierSpec {
  /** Section heading (rendered as an H2). */
  heading: string;
  /** One-line editorial instruction to the report writer, rendered under it. */
  note: string;
}

export const TIER_SPECS: Record<Tier, TierSpec> = {
  lead: {
    heading: "Lead — cross-source correlations",
    note:
      "A company independently flagged by two unrelated sources. This is the one thing " +
      "this pipeline does that a news feed cannot — lead the narrative here.",
  },
  standard: {
    heading: "Standard — single-source discovery",
    note:
      "Insider buys, congressional trades and new 13F positions: genuine discovery value, " +
      "and they usually map to a tradeable public ticker.",
  },
  confirmation: {
    heading: "Confirmation / already-public — contracts & lobbying",
    note:
      "Typically already public by the time we see it (federal contract data averaged ~23d " +
      "stale in report № 1, and the lead item had a company press release 19 days earlier). " +
      "Check for a press release or 8-K before featuring one, and never open the report with " +
      "these. Most items here are also private companies or JVs with no tradeable ticker.",
  },
  meta: {
    heading: "⚠ Pipeline health",
    note: "Problems with our own data, not market signals. Read before trusting the sections below.",
  },
};

/** Content sections, in render order. `meta` is rendered separately, up top. */
export const CONTENT_TIER_ORDER: readonly Tier[] = ["lead", "standard", "confirmation"];

/** Every tier, in the order the digest emits them. */
export const TIER_ORDER: readonly Tier[] = ["meta", ...CONTENT_TIER_ORDER];

/**
 * Where an unrecognised rule lands. `standard` rather than `lead` (don't promote
 * something we've never assessed) and rather than `confirmation` (don't bury it).
 */
export const DEFAULT_TIER: Tier = "standard";

/** Explicit rule → tier assignments. Anything missing falls through to `tierFor`. */
const RULE_TIERS: Readonly<Record<string, Tier>> = {
  // 100% ticker-mapping rate — the correlations only this pipeline produces.
  "13f.cross-source-position": "lead",
  "congress.cross-source-buy": "lead",
  "insiders.cross-source-buy": "lead",

  // Single-source, but genuine discovery.
  "insiders.big-exec-buy": "standard", // 100% ticker rate
  "insiders.cluster-buys": "standard",
  "congress.top-band-buy": "standard",
  "congress.cluster-buys": "standard",
  "congress.fast-filing": "standard",
  "13f.big-new-position": "standard", // 71% ticker rate

  // Confirmation: stale by arrival, and mostly non-tradeable entities.
  "contracts.mega-award": "confirmation", // 17% ticker rate
  "contracts.new-large-recipient": "confirmation", // 8%
  "contracts.spend-spike": "confirmation",
  "lobbying.watched-issue": "confirmation", // 26%
  "lobbying.new-registration": "confirmation", // 7%
  "lobbying.quarterly-spike": "confirmation",
};

/** Rule-name prefixes whose future rules should default to `confirmation`. */
const CONFIRMATION_PREFIXES = ["contracts.", "lobbying."];

/**
 * Tier for a rule. Never throws and never returns undefined: a rule added
 * later (or an old rule name replayed out of the signals table) still
 * gets a section rather than crashing or vanishing from the digest.
 */
export function tierFor(rule: string): Tier {
  const name = typeof rule === "string" ? rule : "";
  const explicit = RULE_TIERS[name];
  if (explicit) return explicit;

  // Prefix/shape inference for rules we haven't classified yet.
  if (name.startsWith("meta.")) return "meta";
  if (name.includes("cross-source")) return "lead";
  if (CONFIRMATION_PREFIXES.some((prefix) => name.startsWith(prefix))) return "confirmation";
  return DEFAULT_TIER;
}
