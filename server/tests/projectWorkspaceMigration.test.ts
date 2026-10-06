import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql, type Kysely } from "kysely";
import { initializeAccessSchema } from "@compass/access";
import { initializeActivitySchema } from "@compass/activity";
import { CreateProjectUseCase, initializeDirectionSchema, SQLiteProjectRepository } from "@compass/direction";
import { GetWorkspaceUseCase, initializeOrganizationSchema, SQLiteWorkspaceRepository } from "@compass/organization";
import { initializeWorkSchema } from "@compass/work";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import {
  asAccessDatabase,
  asActivityDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "../src/bootstrap/database/contextDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import type { Database } from "../src/bootstrap/database/schema.ts";
import { addTestMembership, createSignedInApp, createTestHuman } from "./support/humanSession.ts";

type Row = Record<string, unknown>;

/** `project.workspace_id`を加える前（Workspace Story 02 Task 01の時点）のschema。 */
const initializeLegacySchema = async (database: Kysely<Database>) => {
  await initializeOrganizationSchema(asOrganizationDatabase(database));
  await initializeDirectionSchema(asDirectionDatabase(database));
  await initializeWorkSchema(asWorkDatabase(database));
  await initializeAccessSchema(asAccessDatabase(database));
  await initializeActivitySchema(asActivityDatabase(database));
};

const withTemporaryDatabase = async (run: (path: string) => Promise<void>) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-project-workspace-"));
  try {
    await run(join(directory, "test.db"));
  } finally {
    await rm(directory, { recursive: true });
  }
};

const workspaceTables = ["workspace", "workspace_principle", "workspace_constraint"];

/** Workspaceのtableを除く全tableの全行。`project`は追加した`workspace_id`を除いて比べる。 */
const snapshotExistingRows = async (database: Kysely<Database>) => {
  const tables = (
    await sql<{ name: string }>`select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name`.execute(database)
  ).rows.map(({ name }) => name).filter((name) => !workspaceTables.includes(name));
  const snapshot: Record<string, Row[]> = {};
  for (const table of tables) {
    const rows = (await sql<Row>`select * from ${sql.table(table)} order by rowid`.execute(database)).rows;
    snapshot[table] = table === "project" ? rows.map(({ workspace_id: _workspaceId, ...row }) => row) : rows;
  }
  return snapshot;
};

const projectWorkspaceIds = async (database: Kysely<Database>) =>
  (await sql<{ id: string; workspace_id: string | null }>`select id, workspace_id from project order by created_at, id`.execute(database)).rows;

const getWorkspace = (database: Kysely<Database>, workspaceId: string) =>
  new GetWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute(workspaceId);

const callTool = async (app: Awaited<ReturnType<typeof createSignedInApp>>, name: string, args: object, principal: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${principal}`,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  const { result } = JSON.parse(data.slice(6));
  assert.equal(result.isError, undefined, JSON.stringify(result));
  return result.structuredContent;
};

/**
 * 移行前のDBへ、Project（active・archived）とWork・Grant・Credential・Membership・Activity・Change Logを用意する。
 * 移行前のserverにはWorkspaceへの割当が無いため、Projectは割当なしのRepositoryで作る。
 */
const seedLegacyDatabase = async (database: Kysely<Database>) => {
  await initializeLegacySchema(database);
  const createProject = new CreateProjectUseCase(new SQLiteProjectRepository(asDirectionDatabase(database)));
  const alpha = await createProject.execute({
    name: "Alpha",
    description: "Execution boundary",
    mission: "Keep direction explicit",
    vision: "Every change has a reason",
    principles: ["Trace decisions", "Prefer small steps"],
    constraints: ["No destructive migration"],
    repositories: [{ name: "compass", url: "https://github.com/example/compass" }],
  });
  const beta = await createProject.execute({ name: "Beta", mission: "Ship the archive flow" });

  const services = createApplicationServices(database);
  const app = await createSignedInApp(database, services);
  const owner = await createTestHuman(database);
  await addTestMembership(database, alpha.id, owner, "owner");
  await services.createIntentUseCase.execute(alpha.id, { title: "Intent", desiredState: "State" });
  await services.grantProjectRoleUseCase.execute(alpha.id, { principalId: "planner", role: "manager" });
  await services.issueAccessCredentialUseCase.execute(
    { kind: "human", humanUserId: owner.humanUserId },
    alpha.id,
    { kind: "agent", principalId: "planner" },
  );
  const story = await callTool(app, "issue_story", { projectId: alpha.id, title: "Story", requestId: "story-1" }, "planner");
  await callTool(app, "issue_task", { projectId: alpha.id, storyId: story.id, title: "Task", requestId: "task-1" }, "planner");
  await services.archiveProjectUseCase.execute(beta.id, { reason: "Superseded" });
  return { alpha, beta };
};

test("既存ProjectごとにWorkspaceを作って所属させ、Project IDと既存のWork・Grant・Credential・Change Log・Activityを保つ", async () => {
  await withTemporaryDatabase(async (path) => {
    const legacy = createDatabase(path);
    const { alpha, beta } = await seedLegacyDatabase(legacy);
    const before = await snapshotExistingRows(legacy);
    for (const table of ["story", "task", "project_grant", "access_credential", "project_membership", "change_log", "activity"]) {
      assert.ok(before[table]?.length, `${table}に移行前の行がある`);
    }
    await legacy.destroy();

    const upgraded = createDatabase(path);
    await initializeSchema(upgraded);
    assert.deepEqual(await snapshotExistingRows(upgraded), before);
    const assigned = await projectWorkspaceIds(upgraded);
    assert.deepEqual(assigned.map(({ id }) => id), [alpha.id, beta.id]);
    assert.equal(new Set(assigned.map(({ workspace_id }) => workspace_id)).size, 2);

    const alphaWorkspace = await getWorkspace(upgraded, assigned[0].workspace_id!);
    assert.deepEqual(
      { ...alphaWorkspace, id: undefined },
      {
        id: undefined,
        name: "Alpha",
        mission: "Keep direction explicit",
        vision: "Every change has a reason",
        principles: ["Trace decisions", "Prefer small steps"],
        constraints: ["No destructive migration"],
        createdAt: alpha.createdAt,
        updatedAt: alpha.updatedAt,
        status: "active",
        archivedAt: null,
        archiveReason: null,
      },
    );
    const archivedBeta = await new SQLiteProjectRepository(asDirectionDatabase(upgraded)).findById(beta.id);
    const betaWorkspace = await getWorkspace(upgraded, assigned[1].workspace_id!);
    assert.equal(betaWorkspace.status, "archived");
    assert.equal(betaWorkspace.archivedAt, archivedBeta!.archivedAt);
    assert.equal(betaWorkspace.archiveReason, "Superseded");
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(upgraded)).rows, []);
    await upgraded.destroy();

    // 再起動（schema初期化の再実行）でWorkspaceを重複して作らず、所属も変えない。
    const restarted = createDatabase(path);
    await initializeSchema(restarted);
    assert.deepEqual(await projectWorkspaceIds(restarted), assigned);
    assert.equal((await restarted.selectFrom("workspace").select("id").execute()).length, 2);
    assert.deepEqual(await snapshotExistingRows(restarted), before);
    await restarted.destroy();
  });
});

test("移行が途中で失敗しても、所属済みのProjectは保たれ、未所属のProjectにだけ再実行でWorkspaceを作る", async () => {
  await withTemporaryDatabase(async (path) => {
    const legacy = createDatabase(path);
    await initializeLegacySchema(legacy);
    const createProject = new CreateProjectUseCase(new SQLiteProjectRepository(asDirectionDatabase(legacy)));
    const first = await createProject.execute({ name: "First", mission: "M", principles: ["P"] });
    const broken = await createProject.execute({ name: "Broken", mission: "M", constraints: ["C"] });
    // 2件目のWorkspace作成の途中（子tableの書込）で失敗させる。
    await sql`create trigger fail_broken_constraint before insert on workspace_constraint
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
    await sql`drop trigger fail_broken_constraint`.execute(failed);
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

test("移行後のDBを移行前のserverのschema初期化・Repositoryで開いてもProjectを読み書きでき、次の起動で所属が補われる", async () => {
  await withTemporaryDatabase(async (path) => {
    const upgraded = createDatabase(path);
    await initializeSchema(upgraded);
    const existing = await createApplicationServices(upgraded).createProjectUseCase.execute({ name: "Existing", mission: "M" });
    await upgraded.destroy();

    // 移行前のserverは`workspace_id`を知らず、Projectを割当なしで作る。
    const previous = createDatabase(path);
    await initializeLegacySchema(previous);
    const projects = new SQLiteProjectRepository(asDirectionDatabase(previous));
    const created = await new CreateProjectUseCase(projects).execute({ name: "Created by previous server", mission: "M" });
    assert.equal((await projects.update(existing.id, { mission: "Updated" })).kind, "updated");
    assert.equal((await projects.findById(existing.id))?.mission, "Updated");
    await previous.destroy();

    const restarted = createDatabase(path);
    await initializeSchema(restarted);
    const assigned = await projectWorkspaceIds(restarted);
    assert.deepEqual(assigned.map(({ id }) => id), [existing.id, created.id]);
    assert.ok(assigned.every(({ workspace_id }) => workspace_id));
    assert.equal((await restarted.selectFrom("workspace").select("id").execute()).length, 2);
    await restarted.destroy();
  });
});
