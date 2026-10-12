// Dev utility: run a read-only SQL query against the local db.
//   npx tsx scripts/peek.ts "SELECT COUNT(*) FROM contracts"
import Database from "better-sqlite3";

const sql = process.argv[2];
if (!sql) {
  console.error('Usage: npx tsx scripts/peek.ts "<SELECT ...>"');
  process.exit(1);
}

const db = new Database(process.env.DB_PATH ?? "data/altdata.sqlite", {
  readonly: true,
});
for (const row of db.prepare(sql).all()) {
  console.log(JSON.stringify(row));
}
