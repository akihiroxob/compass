import { fileURLToPath } from "node:url";
import { FileMigrationSource } from "./FileMigrationSource.ts";
import { FileMigrationDistribution } from "./FileMigrationDistribution.ts";
import { PrepareD1MigrationsUseCase } from "./PrepareD1MigrationsUseCase.ts";

try {
  const migrations = await new PrepareD1MigrationsUseCase(new FileMigrationSource(),
    new FileMigrationSource(fileURLToPath(new URL("../d1/migrations/", import.meta.url))),
    new FileMigrationDistribution(fileURLToPath(new URL("../.generated/d1-migrations/", import.meta.url)))).execute();
  console.log(`Prepared D1 migrations: ${migrations.join(", ")}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
