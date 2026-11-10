import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Migration, MigrationSource } from "./MigrateDatabaseUseCase.ts";

const defaultDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));

export class FileMigrationSource implements MigrationSource {
  constructor(private readonly directory = defaultDirectory) {}

  async load(): Promise<Migration[]> {
    const files = (await readdir(this.directory)).filter((name) => /^\d+_[\w-]+\.sql$/.test(name)).sort();
    if (!files.length) throw new Error("Migration files are missing");
    return Promise.all(files.map(async (name) => ({ name, sql: await readFile(join(this.directory, name), "utf8") })));
  }
}
