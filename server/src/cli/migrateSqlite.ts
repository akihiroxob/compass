import { migrateSqlite } from "../bootstrap/database/migrateSqlite.ts";

try {
  const applied = await migrateSqlite(process.env.COMPASS_DB_PATH || "compass.db");
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
