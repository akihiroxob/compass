import Database from "better-sqlite3";
import type { Migration, MigrationRepository } from "./MigrateDatabaseUseCase.ts";

/** SQLiteの履歴照合・スキーマ変更を一つのトランザクションで行う。 */
export class SqliteMigrationRepository implements MigrationRepository {
  constructor(private readonly path: string) {}

  async apply(migrations: Migration[]): Promise<string[]> {
    const files = migrations.map(({ name }) => name);
    const database = new Database(this.path);
    try {
      database.pragma("foreign_keys = ON");
      const apply = database.transaction(() => {
        const hasHistory = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'compass_schema_migration'").get();
        if (!hasHistory) {
          const existing = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1").get();
          if (existing) throw new Error("Existing database has no migration history; use a new database or an explicit migration plan");
          database.exec("CREATE TABLE compass_schema_migration (name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)");
        }
        const applied = new Set((database.prepare("SELECT name FROM compass_schema_migration").all() as { name: string }[]).map(({ name }) => name));
        const unknown = [...applied].filter((name) => !files.includes(name));
        if (unknown.length) throw new Error(`Applied migration is missing from the distribution: ${unknown.join(", ")}`);
        if (files.some((name, index) => applied.has(name) && files.slice(0, index).some((prior) => !applied.has(prior)))) {
          throw new Error("Migration history is not in filename order");
        }
        const pending = migrations.filter(({ name }) => !applied.has(name));
        const record = database.prepare("INSERT INTO compass_schema_migration (name) VALUES (?)");
        for (const migration of pending) {
          database.exec(migration.sql);
          record.run(migration.name);
        }
        return pending.map(({ name }) => name);
      });
      return apply();
    } finally {
      database.close();
    }
  }
}
