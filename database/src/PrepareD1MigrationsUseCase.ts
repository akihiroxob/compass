import type { Migration, MigrationSource } from "./MigrateDatabaseUseCase.ts";

export interface MigrationDistribution {
  /** DBへ適用せず、配布するSQLファイルだけを書き出す。 */
  write(migrations: Migration[]): Promise<void>;
}

/** 共通schemaとD1専用schemaを、名前と内容を保った一つの配布物にする。 */
export class PrepareD1MigrationsUseCase {
  constructor(private readonly shared: MigrationSource, private readonly d1: MigrationSource, private readonly destination: MigrationDistribution) {}

  async execute(): Promise<string[]> {
    const [shared, d1] = await Promise.all([this.shared.load(), this.d1.load()]);
    const migrations = [...shared, ...d1].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    const seen = new Set<string>();
    for (const migration of migrations) {
      if (!/^\d+_[\w-]+\.sql$/.test(migration.name)) throw new Error(`Invalid migration filename: ${migration.name}`);
      if (seen.has(migration.name)) throw new Error(`Duplicate migration filename: ${migration.name}`);
      if (!migration.sql.trim()) throw new Error(`Migration is empty: ${migration.name}`);
      seen.add(migration.name);
    }
    if (!migrations.length) throw new Error("Migration files are missing");
    await this.destination.write(migrations);
    return migrations.map(({ name }) => name);
  }
}
