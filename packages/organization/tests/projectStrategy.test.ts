import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import {
  ArchiveProjectUseCase,
  CreateProjectUseCase,
  CreateWorkspaceProjectUseCase,
  initializeOrganizationSchema,
  ListWorkspaceProjectsUseCase,
  SQLiteProjectRepository,
  SQLiteWorkspaceRepository,
  UpdateProjectUseCase,
  type ProjectChangeNotice,
} from "../src/index.ts";
import { createOrganizationDatabase, noRepositoryReference } from "./support/organizationDatabase.ts";

const input = {
  name: "Compass",
  description: "Direction management",
  mission: "Make direction explicit",
  vision: "Agents improve software",
  principles: ["p1", "p2"],
  constraints: ["c1"],
  repositories: [{ name: "core", url: "https://github.com/example/core" }],
};

const setup = async () => {
  const database = createOrganizationDatabase();
  await initializeOrganizationSchema(database);
  const notices: ProjectChangeNotice[] = [];
  const repository = new SQLiteProjectRepository(database, noRepositoryReference, undefined, () => async (notice) => {
    notices.push(notice);
  });
  return {
    database,
    repository,
    notices,
    workspaces: new SQLiteWorkspaceRepository(database),
    create: new CreateProjectUseCase(repository),
    update: new UpdateProjectUseCase(repository),
    archive: new ArchiveProjectUseCase(repository),
  };
};

const codeOf = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("作成はMission等を専用Workspaceへ書き、Projectには書かない。公開の参照モデルはWorkspaceの値を返す", async () => {
  const { database, repository, workspaces, create } = await setup();
  const created = await create.execute(input);

  const project = (await repository.findById(created.id))!;
  const workspace = (await workspaces.findById(project.workspaceId))!;
  assert.equal(workspace.name, "Compass");
  assert.equal(workspace.mission, "Make direction explicit");
  assert.equal(workspace.vision, "Agents improve software");
  assert.deepEqual(workspace.principles, ["p1", "p2"]);
  assert.deepEqual(workspace.constraints, ["c1"]);
  assert.equal(workspace.status, "active");
  assert.equal("mission" in project, false, "ProjectのEntityは戦略値を持たない");
  assert.deepEqual(project.repositories.map(({ name }) => name), ["core"]);

  assert.deepEqual(Object.keys(created), [
    "id", "workspaceId", "name", "description", "mission", "vision", "principles", "constraints",
    "repositories", "resources", "createdAt", "updatedAt", "status", "archivedAt", "archiveReason",
  ]);
  assert.equal(created.workspaceId, project.workspaceId);
  assert.equal(created.mission, "Make direction explicit");
  assert.deepEqual(created.principles, ["p1", "p2"]);
  await database.destroy();
});

test("Workspaceの所属Project一覧は明示したworkspaceIdのProjectだけをstatusで絞り、Mission等を複製しない", async () => {
  const { database, repository, workspaces, create, archive } = await setup();
  const first = await create.execute(input);
  const second = await new CreateWorkspaceProjectUseCase(repository).execute(first.workspaceId, {
    name: "Platform",
    resources: [{ name: "Docs", url: "https://docs.example", kind: "docs" }],
  });
  const other = await create.execute({ ...input, name: "Other" });
  const list = new ListWorkspaceProjectsUseCase(workspaces, repository);

  const listed = await list.execute(first.workspaceId);
  assert.deepEqual(listed.map(({ id }) => id).sort(), [first.id, second.id].sort());
  assert.ok(listed.every((project) => project.workspaceId === first.workspaceId && !("mission" in project)));
  assert.deepEqual(listed.find(({ id }) => id === second.id)!.resources.map(({ name }) => name), ["Docs"]);
  assert.deepEqual((await list.execute(other.workspaceId)).map(({ id }) => id), [other.id]);

  await archive.execute(second.id, { reason: "Merged" });
  assert.deepEqual((await list.execute(first.workspaceId)).map(({ id }) => id), [first.id]);
  assert.deepEqual((await list.execute(first.workspaceId, "archived")).map(({ id }) => id), [second.id]);
  // archivedのWorkspaceも履歴として参照できる。
  await archive.execute(other.id, { reason: "Done" });
  await workspaces.archive(other.workspaceId, "Done");
  assert.deepEqual((await list.execute(other.workspaceId, "archived")).map(({ id }) => id), [other.id]);
  await assert.rejects(list.execute("missing"), codeOf("NOT_FOUND"));
  await database.destroy();
});

test("Projectの更新はname・purpose・Repository/ResourceだけをProjectへ書き、Mission等（Workspaceの正本）は受け取らない", async () => {
  const { database, repository, workspaces, create, update } = await setup();
  const created = await create.execute(input);
  const { workspaceId } = (await repository.findById(created.id))!;

  const updated = await update.execute(created.id, {
    name: "Compass 2",
    description: "Execution boundary",
    mission: "Hijacked",
    vision: null,
    principles: ["p3"],
    constraints: [],
  });
  assert.equal(updated.name, "Compass 2");
  assert.equal(updated.description, "Execution boundary");
  assert.equal(updated.mission, "Make direction explicit");
  assert.equal(updated.vision, "Agents improve software");
  assert.deepEqual(updated.principles, ["p1", "p2"]);

  const workspace = (await workspaces.findById(workspaceId))!;
  assert.equal(workspace.mission, "Make direction explicit");
  assert.deepEqual(workspace.constraints, ["c1"]);
  assert.equal(workspace.name, "Compass", "Project名の変更はWorkspace名を変えない");

  // Mission等だけの入力は更新項目が無いため拒否し、何も書かない。
  await assert.rejects(() => update.execute(created.id, { mission: "Again" }), codeOf("VALIDATION_ERROR"));
  assert.equal((await workspaces.findById(workspaceId))!.mission, "Make direction explicit");
  await database.destroy();
});

test("archivedのWorkspaceに所属するactiveなProjectは、Projectの項目を更新できる", async () => {
  const { database, repository, workspaces, create, update } = await setup();
  const created = await create.execute(input);
  const { workspaceId } = (await repository.findById(created.id))!;
  await workspaces.archive(workspaceId, "closed");

  assert.equal((await update.execute(created.id, { description: "Still editable" })).description, "Still editable");
  await database.destroy();
});

test("Projectのarchiveは最後のactiveなProjectでも所属Workspaceをarchiveせず、所属Workspace付きで通知する", async () => {
  const { database, repository, workspaces, create, archive, notices } = await setup();
  const alone = await create.execute(input);
  const aloneWorkspaceId = (await repository.findById(alone.id))!.workspaceId;

  const archived = await archive.execute(alone.id, { reason: "done" });
  assert.equal(archived.status, "archived");
  // WorkspaceのarchiveはWorkspace ownerによる別の操作。Projectのarchiveでは状態・理由・日時を変えない。
  const workspace = (await workspaces.findById(aloneWorkspaceId))!;
  assert.deepEqual({ status: workspace.status, archiveReason: workspace.archiveReason, archivedAt: workspace.archivedAt }, { status: "active", archiveReason: null, archivedAt: null });
  assert.deepEqual(notices, [{
    type: "project_archived",
    projectId: alone.id,
    workspaceId: aloneWorkspaceId,
    title: "Compass",
    reason: "done",
    occurredAt: archived.archivedAt,
  }]);

  // 同じWorkspaceの全Projectをarchiveしても、Workspaceはactiveのまま。
  const first = await create.execute({ ...input, name: "A" });
  const second = await create.execute({ ...input, name: "B" });
  const sharedWorkspaceId = (await repository.findById(first.id))!.workspaceId;
  await database.updateTable("project").set({ workspace_id: sharedWorkspaceId }).where("id", "=", second.id).execute();
  await archive.execute(first.id, { reason: "split" });
  assert.equal((await workspaces.findById(sharedWorkspaceId))!.status, "active");
  await archive.execute(second.id, { reason: "all done" });
  assert.equal((await workspaces.findById(sharedWorkspaceId))!.status, "active");

  await assert.rejects(() => archive.execute(alone.id, { reason: "again" }), codeOf("CONFLICT"));
  assert.equal(notices.length, 3);
  await database.destroy();
});

test("archiveの通知先が失敗するとProjectのarchiveは巻き戻り、Workspaceも変わらない", async () => {
  const database = createOrganizationDatabase();
  await initializeOrganizationSchema(database);
  const repository = new SQLiteProjectRepository(database, noRepositoryReference, undefined, () => async () => {
    throw new Error("observer failed");
  });
  const created = await new CreateProjectUseCase(repository).execute(input);
  await assert.rejects(() => new ArchiveProjectUseCase(repository).execute(created.id, { reason: "x" }));

  const project = (await repository.findById(created.id))!;
  assert.equal(project.status, "active");
  assert.equal((await new SQLiteWorkspaceRepository(database).findById(project.workspaceId))!.status, "active");
  await database.destroy();
});

test("ADRから参照されたRepositoryを外す更新は、注入した参照検査で拒否し何も書かない", async () => {
  const database = createOrganizationDatabase();
  await initializeOrganizationSchema(database);
  const checked: string[][] = [];
  const repository = new SQLiteProjectRepository(database, async (_transaction, repositoryIds) => {
    checked.push(repositoryIds);
    return repositoryIds[0] ?? null;
  });
  const created = await new CreateProjectUseCase(repository).execute(input);
  const update = new UpdateProjectUseCase(repository);

  await assert.rejects(() => update.execute(created.id, { name: "Changed", repositories: [] }), (error: unknown) => {
    codeOf("CONFLICT")(error);
    assert.deepEqual((error as { details?: unknown }).details, {
      repositoryId: created.repositories[0]!.id,
      repositoryName: "core",
    });
    return true;
  });
  assert.deepEqual(checked, [[created.repositories[0]!.id]]);
  assert.deepEqual(await repository.findDetailById(created.id), created);
  await database.destroy();
});

const columnsOf = async (database: Awaited<ReturnType<typeof setup>>["database"], table: string) =>
  (await sql<{ name: string; notnull: number }>`select name, "notnull" from pragma_table_info(${table})`.execute(database)).rows;

test("新規DBのprojectは戦略値・移行用の列と旧tableを持たず、所属Workspaceを必須にする。再初期化は保存済みの値を変えない", async () => {
  const { database, repository, create } = await setup();
  assert.deepEqual((await columnsOf(database, "project")).map(({ name, notnull }) => [name, notnull]), [
    ["id", 0], ["workspace_id", 1], ["name", 1], ["description", 0], ["created_at", 1], ["updated_at", 1],
    ["status", 1], ["archived_at", 0], ["archive_reason", 0],
  ]);
  const tables = (await sql<{ name: string }>`select name from sqlite_master where type = 'table'`.execute(database)).rows.map(({ name }) => name);
  assert.equal(tables.includes("project_principle"), false);
  assert.equal(tables.includes("project_constraint"), false);

  const created = await create.execute(input);
  await assert.rejects(() => sql`insert into project (id, name, created_at, updated_at) values ('orphan', 'Orphan', 1, 1)`.execute(database));
  await assert.rejects(() =>
    sql`insert into project (id, workspace_id, name, created_at, updated_at) values ('dangling', 'missing', 'Dangling', 1, 1)`.execute(database));

  await initializeOrganizationSchema(database);
  assert.deepEqual(await repository.findDetailById(created.id), created);
  assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  await database.destroy();
});
