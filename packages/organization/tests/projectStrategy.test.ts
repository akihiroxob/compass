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

const legacyColumns = (database: Awaited<ReturnType<typeof setup>>["database"], projectId: string) =>
  Promise.all([
    database.selectFrom("project").select(["mission", "vision"]).where("id", "=", projectId).executeTakeFirstOrThrow(),
    database.selectFrom("project_principle").select("value").where("project_id", "=", projectId).execute(),
    database.selectFrom("project_constraint").select("value").where("project_id", "=", projectId).execute(),
  ]);

const codeOf = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("作成はMission等を専用Workspaceへ書き、Projectには旧列の値を書かない。公開の参照モデルはWorkspaceの値を返す", async () => {
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

  const [legacy, principles, constraints] = await legacyColumns(database, created.id);
  assert.deepEqual(legacy, { mission: "", vision: null });
  assert.deepEqual(principles, []);
  assert.deepEqual(constraints, []);
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

/** Workspace導入前・正本切替前のserverが書いたProject（旧列に戦略値を持つ）。 */
const insertLegacyProject = async (
  database: Awaited<ReturnType<typeof setup>>["database"],
  values: { id: string; name: string; mission: string; status?: "active" | "archived"; workspaceId?: string; createdAt: number },
) => {
  await database.insertInto("project").values({
    id: values.id,
    workspace_id: values.workspaceId ?? null,
    name: values.name,
    description: null,
    mission: values.mission,
    vision: `${values.name} vision`,
    created_at: values.createdAt,
    updated_at: values.createdAt + 1,
    status: values.status ?? "active",
    archived_at: values.status === "archived" ? values.createdAt + 1 : null,
    archive_reason: values.status === "archived" ? "legacy archive" : null,
    strategy_migrated_at: null,
  }).execute();
  await database.insertInto("project_principle").values([
    { id: `${values.id}-p2`, project_id: values.id, value: "second", sort_order: 1 },
    { id: `${values.id}-p1`, project_id: values.id, value: "first", sort_order: 0 },
  ]).execute();
  await database.insertInto("project_constraint").values(
    { id: `${values.id}-c1`, project_id: values.id, value: `${values.name} constraint`, sort_order: 0 },
  ).execute();
};

test("起動時の移行は旧列の現在値を所属Workspaceへ一度だけ写し、以後のWorkspaceの変更を上書きしない", async () => {
  const { database, repository, workspaces } = await setup();
  // 未所属（Workspace導入前のserverが作成）と、所属済みでWorkspaceが古い写しのまま（正本切替前に旧列を更新）のProject。
  await insertLegacyProject(database, { id: "unassigned", name: "Legacy", mission: "Legacy mission", status: "archived", createdAt: 1_000 });
  const stale = await workspaces.create({ name: "Old name", mission: "Old mission", vision: null, principles: ["old"], constraints: [] });
  await insertLegacyProject(database, { id: "stale", name: "Current", mission: "Current mission", workspaceId: stale.id, createdAt: 2_000 });

  await initializeOrganizationSchema(database);

  const unassigned = (await repository.findById("unassigned"))!;
  const created = (await workspaces.findById(unassigned.workspaceId))!;
  assert.deepEqual(
    { name: created.name, mission: created.mission, vision: created.vision, principles: created.principles, constraints: created.constraints },
    { name: "Legacy", mission: "Legacy mission", vision: "Legacy vision", principles: ["first", "second"], constraints: ["Legacy constraint"] },
  );
  assert.deepEqual(
    { status: created.status, archivedAt: created.archivedAt, archiveReason: created.archiveReason, createdAt: created.createdAt },
    { status: "archived", archivedAt: 1_001, archiveReason: "legacy archive", createdAt: 1_000 },
  );

  const resynced = (await workspaces.findById(stale.id))!;
  assert.equal((await repository.findById("stale"))!.workspaceId, stale.id, "所属は変えない");
  assert.deepEqual(
    { name: resynced.name, mission: resynced.mission, principles: resynced.principles, constraints: resynced.constraints },
    { name: "Current", mission: "Current mission", principles: ["first", "second"], constraints: ["Current constraint"] },
  );

  // 切替後のWorkspaceの変更は、再起動（再初期化）しても旧列で上書きしない。旧列・旧tableは残す。
  await workspaces.update(stale.id, { mission: "Changed after switch" });
  await initializeOrganizationSchema(database);
  assert.equal((await repository.findDetailById("stale"))!.mission, "Changed after switch");
  assert.equal((await database.selectFrom("workspace").select("id").execute()).length, 2, "Workspaceを重複して作らない");
  const [legacy, principles] = await legacyColumns(database, "stale");
  assert.equal(legacy.mission, "Current mission");
  assert.equal(principles.length, 2);
  await database.destroy();
});

test("移行の途中失敗は失敗したProjectだけを戻し、再実行で残りを移行する", async () => {
  const { database, repository, workspaces } = await setup();
  await insertLegacyProject(database, { id: "first", name: "First", mission: "m1", createdAt: 1_000 });
  await insertLegacyProject(database, { id: "second", name: "Second", mission: "m2", createdAt: 2_000 });
  await sql`CREATE TRIGGER fail_second BEFORE INSERT ON workspace WHEN NEW.name = 'Second'
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(database);

  await assert.rejects(() => initializeOrganizationSchema(database));
  assert.ok((await repository.findById("first"))!.workspaceId);
  const second = await database.selectFrom("project").select(["workspace_id", "strategy_migrated_at"])
    .where("id", "=", "second").executeTakeFirstOrThrow();
  assert.deepEqual(second, { workspace_id: null, strategy_migrated_at: null });
  assert.equal((await workspaces.findAll()).length, 1);

  await sql`DROP TRIGGER fail_second`.execute(database);
  await initializeOrganizationSchema(database);
  assert.equal((await repository.findDetailById("second"))!.mission, "m2");
  assert.equal((await workspaces.findAll()).length, 2);
  await database.destroy();
});
