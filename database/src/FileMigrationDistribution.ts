import { mkdir, readdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Migration } from "./MigrateDatabaseUseCase.ts";
import type { MigrationDistribution } from "./PrepareD1MigrationsUseCase.ts";

/** 生成専用ディレクトリへSQLを配布する。正本は書き換えず、削除されたmigrationの古い生成物を残さない。 */
export class FileMigrationDistribution implements MigrationDistribution {
  constructor(private readonly directory: string) {}

  async write(migrations: Migration[]): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const existing = (await readdir(this.directory)).filter((name) => name.endsWith(".sql"));
    const unexpected = existing.find((name) => !/^\d+_[\w-]+\.sql$/.test(name));
    if (unexpected) throw new Error(`Unexpected SQL file in generated migration directory: ${unexpected}`);
    for (const migration of migrations) await writeFile(join(this.directory, migration.name), migration.sql, "utf8");
    const current = new Set(migrations.map(({ name }) => name));
    for (const name of existing) if (!current.has(name)) await unlink(join(this.directory, name));
  }
}
