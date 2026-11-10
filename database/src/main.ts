import { MigrateDatabaseUseCase } from "./MigrateDatabaseUseCase.ts";
import { FileMigrationSource } from "./FileMigrationSource.ts";
import { SqliteMigrationRepository } from "./SqliteMigrationRepository.ts";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";

try {
  if (existsSync(".env")) loadEnvFile(".env");
  const applied = await new MigrateDatabaseUseCase(new FileMigrationSource(), new SqliteMigrationRepository(process.env.COMPASS_DB_PATH || "compass.db")).execute();
  console.log(applied.length ? `Applied migrations: ${applied.join(", ")}` : "Database is up to date");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
