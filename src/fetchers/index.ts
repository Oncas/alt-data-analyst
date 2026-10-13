import type { Config } from "../config.js";
import type { Db } from "../db/index.js";

export interface FetchResult {
  inserted: number;
  skipped: number;
}

export interface FetcherContext {
  db: Db;
  config: Config;
}

export interface Fetcher {
  /** CLI name, e.g. `npm run fetch -- usaspending` */
  name: string;
  fetch(ctx: FetcherContext): Promise<FetchResult>;
}

import { ldaFetcher } from "./lda.js";
import { usaspendingFetcher } from "./usaspending.js";

// Registered as each source lands (PLAN.md phases 2-5):
// usaspending, lda, edgar-form4, congress, edgar-13f
export const fetchers: Fetcher[] = [usaspendingFetcher, ldaFetcher];
