import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { initializeDirectionSchema } from "@compass/direction";
import { CreateWorkspaceUseCase, GetWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { asDirectionDatabase, asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { createLegacyProjectTables, insertLegacyProject } from "./support/legacyProjectSchema.ts";

const tableNames = async (database: ReturnType<typeof createDatabase>) =>
  (await sql<{ name: string }>`select name from sqlite_master where type = 'table' order by name`.execute(database)).rows
    .map(({ name }) => name);

/** 加えた列（`workspace_id`・`strategy_migrated_at`）も含めて読む。 */
const projectRowOf = async (database: ReturnType<typeof createDatabase>, projectId: string) =>
  (await sql<Record<string, unknown>>`select * from project where id = ${projectId}`.execute(database)).rows[0];

test("Workspace導入前のDBにserverのschema初期化を適用すると、Workspaceのtableを加え既存Projectを1つのWorkspaceへ所属させる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-schema-"));
  const path = join(directory, "test.db");

  // Workspace導入前の構成（Organizationのtableなし）でProjectを作る。
  const legacy = createDatabase(path);
  await createLegacyProjectTables(legacy);
  await initializeDirectionSchema(asDirectionDatabase(legacy));
  const project = await insertLegacyProject(legacy, {
    name: "Compass", mission: "Make direction explicit", principles: ["Trace decisions"], createdAt: 1_000,
  });
  assert.ok(!(await tableNames(legacy)).includes("workspace"));
  const projectRow = await projectRowOf(legacy, project.id);
  await legacy.destroy();

  const upgraded = createDatabase(path);
  await initializeSchema(upgraded);
  const tables = await tableNames(upgraded);
  for (const table of ["workspace", "workspace_principle", "workspace_constraint"]) assert.ok(tables.includes(table), table);
  const { workspace_id: workspaceId, strategy_migrated_at: migratedAt, ...upgradedRow } = await projectRowOf(upgraded, project.id);
  assert.deepEqual(upgradedRow, projectRow);
  assert.equal(typeof migratedAt, "number");
  assert.deepEqual((await upgraded.selectFrom("workspace").select("id").execute()).map(({ id }) => id), [workspaceId]);

  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(upgraded))).execute({
    name: "Compass", mission: "Make direction explicit", principles: ["Trace decisions"],
  });
  await upgraded.destroy();

  // 再起動（schema初期化の再実行）でもWorkspaceと既存Projectは変わらない。
  const restarted = createDatabase(path);
  await initializeSchema(restarted);
  assert.deepEqual(
    await new GetWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(restarted))).execute(workspace.id),
    workspace,
  );
  assert.deepEqual(await projectRowOf(restarted, project.id), {
    ...projectRow,
    workspace_id: workspaceId,
    strategy_migrated_at: migratedAt,
  });
  assert.equal((await restarted.selectFrom("workspace").select("id").execute()).length, 2);
  assert.deepEqual((await sql`pragma foreign_key_check`.execute(restarted)).rows, []);
  await restarted.destroy();
  await rm(directory, { recursive: true });
});
