import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { CreateProjectUseCase } from "../src/application/usecase/CreateProjectUseCase.ts";
import { GetProjectUseCase } from "../src/application/usecase/GetProjectUseCase.ts";
import { UpdateProjectUseCase } from "../src/application/usecase/UpdateProjectUseCase.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { SQLiteProjectRepository } from "../src/infrastructure/repository/SQLiteProjectRepository.ts";

const fullInput = {
  name: "Compass",
  description: "Direction management",
  mission: "Make direction explicit",
  vision: "Agents improve software continuously",
  principles: ["p1", "p2", "p3"],
  constraints: ["c1", "c2"],
  repositories: [
    { name: "core", url: "https://github.com/example/core" },
    { name: "web", url: "https://github.com/example/web" },
  ],
  resources: [
    { name: "Design", url: "https://example.com/design", kind: "docs" },
    { name: "Board", url: "https://example.com/board" },
  ],
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const repository = new SQLiteProjectRepository(database);
  return {
    database,
    repository,
    create: new CreateProjectUseCase(repository),
    update: new UpdateProjectUseCase(repository),
    get: new GetProjectUseCase(repository),
  };
};

const codeOf = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("更新は同じIDのまま内容を変更し、再起動後も保持される", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-update-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const created = await first.create.execute(fullInput);

  const updated = await first.update.execute(created.id, {
    name: " Compass 2 ",
    mission: "New mission",
    principles: ["p3", "new"],
    constraints: [],
  });
  assert.equal(updated.id, created.id);
  assert.equal(updated.createdAt, created.createdAt);
  assert.ok(updated.updatedAt >= created.updatedAt);
  await first.database.destroy();

  const second = await setup(path);
  const found = await second.get.execute(created.id);
  assert.equal(found.name, "Compass 2");
  assert.equal(found.mission, "New mission");
  assert.deepEqual(found.principles, ["p3", "new"]);
  assert.deepEqual(found.constraints, []);
  assert.equal(found.createdAt, created.createdAt);
  assert.equal((await second.repository.findAll()).length, 1);
  await second.database.destroy();
  await rm(directory, { recursive: true });
});

test("未指定の項目は変更せず、null・空文字でだけ任意値をクリアする", async () => {
  const { database, create, update } = await setup();
  const created = await create.execute(fullInput);

  const onlyName = await update.execute(created.id, { name: "Renamed" });
  assert.equal(onlyName.name, "Renamed");
  assert.equal(onlyName.description, created.description);
  assert.equal(onlyName.vision, created.vision);
  assert.deepEqual(onlyName.principles, created.principles);
  assert.deepEqual(onlyName.constraints, created.constraints);
  assert.deepEqual(onlyName.repositories, created.repositories);
  assert.deepEqual(onlyName.resources, created.resources);

  const cleared = await update.execute(created.id, { description: null, vision: "  " });
  assert.equal(cleared.description, null);
  assert.equal(cleared.vision, null);
  assert.equal(cleared.name, "Renamed");

  const emptyLists = await update.execute(created.id, {
    principles: [], repositories: [], resources: [],
  });
  assert.deepEqual(emptyLists.principles, []);
  assert.deepEqual(emptyLists.repositories, []);
  assert.deepEqual(emptyLists.resources, []);
  assert.deepEqual(emptyLists.constraints, created.constraints);
  await database.destroy();
});

test("Repository/Resourceは既存idの行を維持し、追加・修正・削除・並べ替えを保存する", async () => {
  const { database, create, update } = await setup();
  const created = await create.execute(fullInput);
  const [core, web] = created.repositories;
  const [design, board] = created.resources;

  const updated = await update.execute(created.id, {
    repositories: [
      { id: web!.id, name: "web renamed", url: "https://github.com/example/web2" },
      { name: "added", url: "https://github.com/example/added" },
    ],
    resources: [
      { id: board!.id, name: "Board", url: "https://example.com/board", kind: "kanban" },
      { id: design!.id, name: "Design", url: "https://example.com/design" },
    ],
  });

  assert.deepEqual(updated.repositories.map((item) => item.name), ["web renamed", "added"]);
  assert.equal(updated.repositories[0]?.id, web!.id);
  assert.equal(updated.repositories[0]?.url, "https://github.com/example/web2");
  assert.ok(!updated.repositories.some((item) => item.id === core!.id));
  assert.ok(updated.repositories[1]?.id && updated.repositories[1].id !== web!.id);

  assert.deepEqual(updated.resources.map((item) => item.id), [board!.id, design!.id]);
  assert.equal(updated.resources[0]?.kind, "kanban");
  assert.equal(updated.resources[1]?.kind, null);
  await database.destroy();
});

test("他Projectの子idは奪わず、新しい行として追加する", async () => {
  const { database, create, update, get } = await setup();
  const mine = await create.execute(fullInput);
  const other = await create.execute({ ...fullInput, name: "Other" });
  const foreign = other.repositories[0]!;

  const updated = await update.execute(mine.id, {
    repositories: [{ id: foreign.id, name: "mine", url: "https://github.com/example/mine" }],
  });
  assert.equal(updated.repositories.length, 1);
  assert.notEqual(updated.repositories[0]?.id, foreign.id);

  const untouched = await get.execute(other.id);
  assert.deepEqual(untouched.repositories, other.repositories);
  assert.deepEqual(untouched.resources, other.resources);
  assert.equal(untouched.name, "Other");
  await database.destroy();
});

test("不正な更新は拒否し、既存データを変更しない", async () => {
  const { database, create, update, get } = await setup();
  const created = await create.execute(fullInput);

  const invalidInputs: [string, unknown, string][] = [
    ["空白のname", { name: "   " }, "name"],
    ["空のmission", { mission: "" }, "mission"],
    ["不正URL", { repositories: [{ name: "x", url: "not a url" }] }, "repositories.0.url"],
    ["file URL", { resources: [{ name: "x", url: "file:///tmp/x" }] }, "resources.0.url"],
    ["空のprinciple", { principles: ["ok", " "] }, "principles.1"],
    ["重複id", { repositories: [
      { id: created.repositories[0]!.id, name: "a", url: "https://example.com/a" },
      { id: created.repositories[0]!.id, name: "b", url: "https://example.com/b" },
    ] }, "repositories.1.id"],
    ["上限超過", { constraints: Array.from({ length: 21 }, () => "x") }, "constraints"],
    ["空更新", {}, ""],
  ];
  for (const [label, input, path] of invalidInputs) {
    await assert.rejects(() => update.execute(created.id, input), (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VALIDATION_ERROR", label);
      const issues = (error as { issues: { path: string }[] }).issues;
      assert.ok(issues.some((issue) => issue.path === path), `${label}: ${JSON.stringify(issues)}`);
      return true;
    });
  }
  await assert.rejects(() => update.execute(created.id, null), codeOf("VALIDATION_ERROR"));
  await assert.rejects(() => update.execute(created.id, []), codeOf("VALIDATION_ERROR"));

  assert.deepEqual(await get.execute(created.id), created);
  await database.destroy();
});

test("存在しないIDはNOT_FOUNDとして区別し、何も作成しない", async () => {
  const { database, repository, update } = await setup();
  await assert.rejects(() => update.execute("missing", { name: "x" }), codeOf("NOT_FOUND"));
  await assert.rejects(() => update.execute("missing", { name: " " }), codeOf("VALIDATION_ERROR"));
  assert.deepEqual(await repository.findAll(), []);
  await database.destroy();
});

test("保存に失敗した更新は親も他の子も部分更新しない", async () => {
  const { database, create, update, get } = await setup();
  const created = await create.execute(fullInput);

  await sql`CREATE TRIGGER fail_resource_insert BEFORE INSERT ON project_resource
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(database);
  await assert.rejects(() =>
    update.execute(created.id, {
      name: "Should roll back",
      principles: ["changed"],
      repositories: [{ name: "changed", url: "https://example.com/changed" }],
      resources: [{ name: "new", url: "https://example.com/new" }],
    }),
  );

  assert.deepEqual(await get.execute(created.id), created);
  await database.destroy();
});
