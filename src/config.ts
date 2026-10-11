import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DB_PATH: z.string().default("data/altdata.sqlite"),
  SEC_USER_AGENT: z.string().optional(),
  LDA_API_KEY: z.string().optional(),
  MIN_CONTRACT_USD: z.coerce.number().default(5_000_000),
});

export type Config = z.infer<typeof schema>;

export const config: Config = schema.parse(process.env);
