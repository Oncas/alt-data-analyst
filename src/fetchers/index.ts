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

import { congressFetcher } from "./congress.js";
import { edgar13fFetcher } from "./edgar13f.js";
import { edgarForm4Fetcher } from "./edgarForm4.js";
import { ldaFetcher } from "./lda.js";
import { tickersFetcher } from "./tickers.js";
import { usaspendingFetcher } from "./usaspending.js";

export const fetchers: Fetcher[] = [
  usaspendingFetcher,
  ldaFetcher,
  edgarForm4Fetcher,
  congressFetcher,
  tickersFetcher,
  edgar13fFetcher,
];
