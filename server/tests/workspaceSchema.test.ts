import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { CreateProjectUseCase, initializeDirectionSchema, SQLiteProjectRepository } from "@compass/direction";
import { CreateWorkspaceUseCase, GetWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { asDirectionDatabase, asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

const tableNames = async (database: ReturnType<typeof createDatabase>) =>
  (await sql<{ name: string }>`select name from sqlite_master where type = 'table' order by name`.execute(database)).rows
    .map(({ name }) => name);

test("Workspace導入前のDBにserverのschema初期化を適用すると、既存Projectを変えずにWorkspaceのtableを加える", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-schema-"));
  const path = join(directory, "test.db");

  // Workspace導入前の構成（Organizationのtableなし）でProjectを作る。
  const legacy = createDatabase(path);
  await initializeDirectionSchema(asDirectionDatabase(legacy));
  const project = await new CreateProjectUseCase(new SQLiteProjectRepository(asDirectionDatabase(legacy))).execute({
    name: "Compass", mission: "Make direction explicit", principles: ["Trace decisions"],
  });
  assert.ok(!(await tableNames(legacy)).includes("workspace"));
  const projectRow = await legacy.selectFrom("project").selectAll().where("id", "=", project.id).executeTakeFirstOrThrow();
  await legacy.destroy();

  const upgraded = createDatabase(path);
  await initializeSchema(upgraded);
  const tables = await tableNames(upgraded);
  for (const table of ["workspace", "workspace_principle", "workspace_constraint"]) assert.ok(tables.includes(table), table);
  assert.deepEqual(await upgraded.selectFrom("project").selectAll().where("id", "=", project.id).executeTakeFirst(), projectRow);
  assert.deepEqual(await upgraded.selectFrom("workspace").selectAll().execute(), []);

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
  assert.deepEqual(await restarted.selectFrom("project").selectAll().where("id", "=", project.id).executeTakeFirst(), projectRow);
  assert.equal((await restarted.selectFrom("workspace").select("id").execute()).length, 1);
  assert.deepEqual((await sql`pragma foreign_key_check`.execute(restarted)).rows, []);
  await restarted.destroy();
  await rm(directory, { recursive: true });
});
