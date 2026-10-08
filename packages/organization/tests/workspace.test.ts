import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ArchiveWorkspaceUseCase,
  CreateWorkspaceUseCase,
  GetWorkspaceUseCase,
  initializeOrganizationSchema,
  ListWorkspacesUseCase,
  SQLiteWorkspaceRepository,
  UpdateWorkspaceUseCase,
} from "../src/index.ts";
import { createOrganizationDatabase } from "./support/organizationDatabase.ts";

const setup = async () => {
  const database = createOrganizationDatabase();
  await initializeOrganizationSchema(database);
  const repository = new SQLiteWorkspaceRepository(database);
  return {
    database,
    repository,
    create: new CreateWorkspaceUseCase(repository),
    get: new GetWorkspaceUseCase(repository),
    list: new ListWorkspacesUseCase(repository),
    update: new UpdateWorkspaceUseCase(repository),
    archive: new ArchiveWorkspaceUseCase(repository),
  };
};

const rejectsWithCode = async (action: () => Promise<unknown>, code: string) =>
  assert.rejects(action, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    return true;
  });

test("WorkspaceのMission / Vision / Principles / Constraintsとstatusが永続化され、再接続後も残る", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-"));
  const path = join(directory, "test.db");
  const first = createOrganizationDatabase(path);
  await initializeOrganizationSchema(first);

  const created = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(first)).execute({
    name: " Petari ",
    mission: " Make direction explicit ",
    vision: " Agents improve software continuously ",
    principles: ["Trace decisions", "Persist state"],
    constraints: ["No secrets in repositories"],
  });
  assert.equal(created.status, "active");
  assert.equal(created.archivedAt, null);
  await first.destroy();

  const reopened = createOrganizationDatabase(path);
  await initializeOrganizationSchema(reopened);
  const found = await new GetWorkspaceUseCase(new SQLiteWorkspaceRepository(reopened)).execute(created.id);

  assert.equal(found.name, "Petari");
  assert.equal(found.mission, "Make direction explicit");
  assert.equal(found.vision, "Agents improve software continuously");
  assert.deepEqual(found.principles, ["Trace decisions", "Persist state"]);
  assert.deepEqual(found.constraints, ["No secrets in repositories"]);
  assert.equal(found.status, "active");

  await reopened.destroy();
  await rm(directory, { recursive: true });
});

test("作成入力を検証し、statusなどserver管理の項目は受け取らない", async () => {
  const { database, create } = await setup();

  await rejectsWithCode(() => create.execute({ name: " ", mission: "" }), "VALIDATION_ERROR");
  await rejectsWithCode(() => create.execute({ name: "W", mission: "M", principles: [" "] }), "VALIDATION_ERROR");

  const workspace = await create.execute({ name: "W", mission: "M", status: "archived", vision: " " });
  assert.equal(workspace.status, "active");
  assert.equal(workspace.vision, null);
  assert.deepEqual(workspace.principles, []);
  await database.destroy();
});

test("存在しないWorkspaceの参照・更新・archiveはNOT_FOUND", async () => {
  const { database, get, update, archive } = await setup();

  await rejectsWithCode(() => get.execute("missing"), "NOT_FOUND");
  await rejectsWithCode(() => update.execute("missing", { name: "x" }), "NOT_FOUND");
  await rejectsWithCode(() => archive.execute("missing", { reason: "x" }), "NOT_FOUND");
  await database.destroy();
});

test("部分更新は指定した項目だけを変え、配列は全体を置き換え、visionは空でクリアできる", async () => {
  const { database, create, update } = await setup();
  const workspace = await create.execute({
    name: "W", mission: "M", vision: "V", principles: ["a", "b"], constraints: ["c"],
  });

  const updated = await update.execute(workspace.id, { principles: ["b", "a", "z"], vision: "" });
  assert.equal(updated.name, "W");
  assert.equal(updated.mission, "M");
  assert.equal(updated.vision, null);
  assert.deepEqual(updated.principles, ["b", "a", "z"]);
  assert.deepEqual(updated.constraints, ["c"]);
  assert.ok(updated.updatedAt >= workspace.updatedAt);

  await rejectsWithCode(() => update.execute(workspace.id, {}), "VALIDATION_ERROR");
  await rejectsWithCode(() => update.execute(workspace.id, { mission: " " }), "VALIDATION_ERROR");
  await database.destroy();
});

test("archiveは理由を残してarchivedへ遷移し、以後の更新と再archiveを拒否して値を上書きしない", async () => {
  const { database, create, get, update, archive } = await setup();
  const workspace = await create.execute({ name: "W", mission: "M", principles: ["p"] });

  await rejectsWithCode(() => archive.execute(workspace.id, { reason: " " }), "VALIDATION_ERROR");
  const archived = await archive.execute(workspace.id, { reason: " 統合のため " });
  assert.equal(archived.status, "archived");
  assert.equal(archived.archiveReason, "統合のため");
  assert.equal(archived.archivedAt, archived.updatedAt);
  assert.deepEqual(archived.principles, ["p"]);

  await assert.rejects(
    () => update.execute(workspace.id, { name: "changed" }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "CONFLICT");
      assert.equal((error as { details?: Record<string, string> }).details?.workspaceStatus, "archived");
      return true;
    },
  );
  await rejectsWithCode(() => archive.execute(workspace.id, { reason: "again" }), "CONFLICT");

  const found = await get.execute(workspace.id);
  assert.equal(found.name, "W");
  assert.equal(found.archiveReason, "統合のため");
  assert.equal(found.archivedAt, archived.archivedAt);
  await database.destroy();
});

test("一覧は既定でactiveだけを更新の新しい順に返し、archivedは明示して参照する", async () => {
  const { database, create, update, archive, list } = await setup();
  const first = await create.execute({ name: "First", mission: "M" });
  const second = await create.execute({ name: "Second", mission: "M" });
  const archived = await create.execute({ name: "Archived", mission: "M" });
  await archive.execute(archived.id, { reason: "done" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  await update.execute(first.id, { name: "First updated" });

  assert.deepEqual((await list.execute()).map(({ id }) => id), [first.id, second.id]);
  assert.deepEqual((await list.execute("archived")).map(({ id }) => id), [archived.id]);
  await database.destroy();
});

test("子要素の書込に失敗した作成は親も保存しない", async () => {
  const { database, repository } = await setup();
  await assert.rejects(() =>
    repository.create({
      name: "W", mission: "M", vision: null, principles: ["ok"], constraints: [null as unknown as string],
    }),
  );
  assert.deepEqual(await database.selectFrom("workspace").selectAll().execute(), []);
  assert.deepEqual(await database.selectFrom("workspace_principle").selectAll().execute(), []);
  await database.destroy();
});

test("schemaの初期化は再実行しても既存のWorkspaceを変えない", async () => {
  const { database, create, get } = await setup();
  const workspace = await create.execute({ name: "W", mission: "M", constraints: ["c"] });
  await initializeOrganizationSchema(database);
  assert.deepEqual(await get.execute(workspace.id), workspace);
  await database.destroy();
});
