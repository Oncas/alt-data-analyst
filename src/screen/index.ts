import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

export interface RuleContext {
  db: Db;
  config: Config;
}

export interface Rule {
  /** e.g. "contracts.new-large-award" */
  name: string;
  /** Scans raw tables, inserts into signals; returns count of new signals. */
  run(ctx: RuleContext): number;
}

import { contractRules } from "./contracts.js";

// Registered as each source's rules land (PLAN.md phases 2-5).
export const rules: Rule[] = [...contractRules];
