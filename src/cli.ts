import { config } from "./config.js";
import { openDb } from "./db/index.js";
import { fetchers } from "./fetchers/index.js";
import { rules } from "./screen/index.js";

const [command, target] = process.argv.slice(2);

function usage(): never {
  console.log("Usage: tsx src/cli.ts <fetch|screen|report> [source]");
  process.exit(command ? 1 : 0);
}

async function runFetch(): Promise<void> {
  const db = openDb(config.DB_PATH);
  const selected = target ? fetchers.filter((f) => f.name === target) : fetchers;
  if (target && selected.length === 0) {
    console.error(
      `Unknown source "${target}". Registered: ${fetchers.map((f) => f.name).join(", ") || "(none)"}`,
    );
    process.exit(1);
  }
  if (selected.length === 0) {
    console.log(`Database ready at ${config.DB_PATH}.`);
    console.log("No fetchers registered yet — sources land in PLAN.md phases 2-5.");
    return;
  }
  for (const fetcher of selected) {
    const started = Date.now();
    try {
      const result = await fetcher.fetch({ db, config });
      console.log(
        `${fetcher.name}: ${result.inserted} inserted, ${result.skipped} skipped ` +
          `(${((Date.now() - started) / 1000).toFixed(1)}s)`,
      );
    } catch (error) {
      // One broken source must not take down the others.
      console.error(`${fetcher.name}: FAILED — ${(error as Error).message}`);
      process.exitCode = 1;
    }
  }
}

function runScreen(): void {
  const db = openDb(config.DB_PATH);
  if (rules.length === 0) {
    console.log("No screening rules registered yet — rules land in PLAN.md phases 2-5.");
    return;
  }
  for (const rule of rules) {
    const count = rule.run({ db, config });
    console.log(`${rule.name}: ${count} new signal(s)`);
  }
}

function runReport(): void {
  const db = openDb(config.DB_PATH);
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM signals WHERE reported_at IS NULL")
    .get() as { n: number };
  console.log(`${row.n} unreported signal(s). Digest formatting lands in Task 4.`);
}

switch (command) {
  case "fetch":
    await runFetch();
    break;
  case "screen":
    runScreen();
    break;
  case "report":
    runReport();
    break;
  default:
    usage();
}
