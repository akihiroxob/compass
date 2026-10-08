import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql, type Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeDirectionSchema } from "@compass/direction";
import { GetWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { initializeWorkSchema } from "@compass/work";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import {
  asAccessDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "../src/bootstrap/database/contextDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import type { Database } from "../src/bootstrap/database/schema.ts";
import { createLegacyProjectTables, insertLegacyProject } from "./support/legacyProjectSchema.ts";

/** Workspace導入前のschema（`project`はDirectionが所有し、Organizationのtableは無い）。 */
const initializeLegacySchema = async (database: Kysely<Database>) => {
  await createLegacyProjectTables(database);
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
};

const withTemporaryDatabase = async (run: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-project-workspace-"));
  try {
    await run(join(directory, "test.db"));
  } finally {
    await rm(directory, { recursive: true });
  }
};

const projectWorkspaceIds = async (database: Kysely<Database>) =>
  (await sql<{ id: string; workspace_id: string | null }>`select id, workspace_id from project order by created_at, id`.execute(database)).rows;

const getWorkspace = (database: Kysely<Database>, workspaceId: string) =>
  new GetWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute(workspaceId);

// 旧Activityの非破壊移行は対象外。scope変更後の新規DB・再起動・公開入口はactivity.test.tsで検証する。
test("移行が途中で失敗しても、所属済みのProjectは保たれ、未所属のProjectにだけ再実行でWorkspaceを作る", async () => {
  await withTemporaryDatabase(async (path) => {
    const legacy = createDatabase(path);
    await initializeLegacySchema(legacy);
    const first = await insertLegacyProject(legacy, { name: "First", mission: "M", principles: ["P"], createdAt: 1_000 });
    const broken = await insertLegacyProject(legacy, { name: "Broken", mission: "M", constraints: ["C"], createdAt: 2_000 });
    // 2件目の移行の途中（Workspaceを書いた後の所属の設定）で失敗させる。
    await sql`create trigger fail_broken_assignment before update on project when new.name = 'Broken'
      begin select raise(abort, 'simulated failure'); end`.execute(legacy);
    await legacy.destroy();

    const failed = createDatabase(path);
    await assert.rejects(initializeSchema(failed), /simulated failure/);
    const partial = await projectWorkspaceIds(failed);
    assert.ok(partial[0].workspace_id);
    assert.deepEqual(partial.map(({ id }) => id), [first.id, broken.id]);
    assert.equal(partial[1].workspace_id, null);
    // 失敗したProjectのWorkspaceは残らない（同じtransactionで戻る）。
    assert.deepEqual((await failed.selectFrom("workspace").select("name").execute()).map(({ name }) => name), ["First"]);
    await sql`drop trigger fail_broken_assignment`.execute(failed);
    await failed.destroy();

    const retried = createDatabase(path);
    await initializeSchema(retried);
    const assigned = await projectWorkspaceIds(retried);
    assert.equal(assigned[0].workspace_id, partial[0].workspace_id);
    assert.ok(assigned[1].workspace_id);
    assert.deepEqual((await retried.selectFrom("workspace").select("name").orderBy("name").execute()).map(({ name }) => name), [
      "Broken",
      "First",
    ]);
    assert.deepEqual((await getWorkspace(retried, assigned[1].workspace_id!)).constraints, ["C"]);
    await retried.destroy();
  });
});

test("移行後のProject作成は同じtransactionでWorkspaceへ所属させ、割当に失敗すればProjectも作らない", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);

  const project = await services.createProjectUseCase.execute({ name: "Gamma", mission: "M", vision: "V", principles: ["P"] });
  const [{ workspace_id: workspaceId }] = await projectWorkspaceIds(database);
  assert.ok(workspaceId);
  const workspace = await getWorkspace(database, workspaceId);
  assert.deepEqual([workspace.name, workspace.mission, workspace.vision, workspace.principles, workspace.status], [
    "Gamma",
    "M",
    "V",
    ["P"],
    "active",
  ]);
  assert.equal(workspace.createdAt, project.createdAt);

  await sql`create trigger fail_workspace before insert on workspace begin select raise(abort, 'simulated failure'); end`.execute(database);
  await assert.rejects(services.createProjectUseCase.execute({ name: "Delta", mission: "M" }), /simulated failure/);
  assert.deepEqual((await projectWorkspaceIds(database)).map(({ id }) => id), [project.id]);
  await database.destroy();
});

test("正本の切替後に旧serverが書いたProjectは次の起動で所属を補い、切替済みProjectのWorkspaceは旧列で上書きしない", async () => {
  await withTemporaryDatabase(async (path) => {
    const upgraded = createDatabase(path);
    await initializeSchema(upgraded);
    const existing = await createApplicationServices(upgraded).createProjectUseCase.execute({ name: "Existing", mission: "M" });

    // 旧serverは`workspace_id`・`strategy_migrated_at`を知らず、旧列だけを読み書きする。
    const created = await insertLegacyProject(upgraded, {
      name: "Created by previous server",
      mission: "Legacy",
      createdAt: existing.createdAt + 1,
    });
    await sql`update project set mission = 'Updated by previous server' where id = ${existing.id}`.execute(upgraded);
    await upgraded.destroy();

    const restarted = createDatabase(path);
    await initializeSchema(restarted);
    const assigned = await projectWorkspaceIds(restarted);
    assert.deepEqual(assigned.map(({ id }) => id), [existing.id, created.id]);
    assert.ok(assigned.every(({ workspace_id }) => workspace_id));
    assert.equal((await restarted.selectFrom("workspace").select("id").execute()).length, 2);
    const services = createApplicationServices(restarted);
    assert.equal((await services.getProjectUseCase.execute(created.id)).mission, "Legacy");
    // 切替後の旧列への書込は反映しない（旧serverへ戻す場合はDB fileの複製へ戻す。README）。
    assert.equal((await services.getProjectUseCase.execute(existing.id)).mission, "M");
    await restarted.destroy();
  });
});
