import { createApplicationServices } from "../../createApplicationServices.ts";
import { createDatabase } from "../../infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../../infrastructure/database/initializeSchema.ts";
import { runCli } from "./runCli.ts";

// サーバーを起動せずに、同じDB file（COMPASS_DB_PATH）とUse Caseを使う。import時にDBを開くcontainerは読み込まない。
const database = createDatabase();
try {
  await initializeSchema(database);
  const result = await runCli(process.argv.slice(2), createApplicationServices(database));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } }));
  process.exitCode = 1;
} finally {
  await database.destroy();
}
