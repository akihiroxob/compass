import { createCliServices } from "./bootstrap.ts";
import { runCli } from "./runCli.ts";

const runtime = createCliServices(process.env.COMPASS_DB_PATH || "compass.db");
try {
  const result = await runCli(process.argv.slice(2), runtime.services);
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(JSON.stringify({ error: { code: "INTERNAL_ERROR", message: error instanceof Error ? error.message : String(error) } }));
  process.exitCode = 1;
} finally {
  await runtime.close();
}
