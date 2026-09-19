import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createApplicationServices } from "../src/container.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const projectInput = { name: "Compass", mission: "Keep direction explicit" };
const intentInput = {
  title: "Agents improve software",
  desiredState: "Humans give an Intent and agents improve the software.",
  completionDefinition: "Improvements ship without manual coordination.",
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database) };
};

const codeOf = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

test("Intentは作成時にactiveで保存され、再起動後も同じIDと内容で取得できる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-intent-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const project = await first.services.createProjectUseCase.execute(projectInput);
  const created = await first.services.createIntentUseCase.execute(project.id, intentInput);
  assert.equal(created.status, "active");
  assert.equal(created.projectId, project.id);
  assert.equal(created.abandonedReason, null);
  await first.database.destroy();

  const second = await setup(path);
  const fetched = await second.services.getIntentUseCase.execute(project.id, created.id);
  assert.deepEqual(fetched, created);
  const listed = await second.services.listIntentsUseCase.execute(project.id);
  assert.deepEqual(listed, [created]);
  await second.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("initializeSchemaは既存DBに対して再実行してもIntentを壊さない", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const created = await services.createIntentUseCase.execute(project.id, intentInput);
  await initializeSchema(database);
  assert.deepEqual(await services.getIntentUseCase.execute(project.id, created.id), created);
  await database.destroy();
});

test("入力はtrimされ、completionDefinitionの省略と空文字はnullになる", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const created = await services.createIntentUseCase.execute(project.id, {
    title: "  Title  ",
    desiredState: "  State  ",
    completionDefinition: "   ",
  });
  assert.equal(created.title, "Title");
  assert.equal(created.desiredState, "State");
  assert.equal(created.completionDefinition, null);
  await database.destroy();
});

test("不正な入力はVALIDATION_ERRORで拒否し、保存しない", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);

  const invalidInputs: [unknown, string][] = [
    [{ title: " ", desiredState: "x" }, "title"],
    [{ title: "x", desiredState: " " }, "desiredState"],
    [{ title: "x".repeat(101), desiredState: "x" }, "title"],
    [{ title: "x", desiredState: "x".repeat(2_001) }, "desiredState"],
    [{ title: "x", desiredState: "x", completionDefinition: "x".repeat(2_001) }, "completionDefinition"],
    [{ desiredState: "x" }, "title"],
    [null, ""],
    [[], ""],
  ];
  for (const [input, path] of invalidInputs) {
    await assert.rejects(
      services.createIntentUseCase.execute(project.id, input),
      (error: { code?: string; issues?: { path: string }[] }) => {
        assert.equal(error.code, "VALIDATION_ERROR", JSON.stringify(input));
        assert.equal(error.issues?.[0]?.path, path, JSON.stringify(input));
        return true;
      },
    );
  }
  assert.deepEqual(await services.listIntentsUseCase.execute(project.id), []);

  const boundary = await services.createIntentUseCase.execute(project.id, {
    title: "x".repeat(100),
    desiredState: "y".repeat(2_000),
    completionDefinition: "z".repeat(2_000),
  });
  assert.equal(boundary.title.length, 100);
  await database.destroy();
});

test("Active Intentは1 Projectにつき最大1件で、2件目はCONFLICTになり既存は変わらない", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const first = await services.createIntentUseCase.execute(project.id, intentInput);

  await assert.rejects(
    services.createIntentUseCase.execute(project.id, { title: "Second", desiredState: "Second" }),
    (error: { code?: string; details?: Record<string, string> }) => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.details?.activeIntentId, first.id);
      return true;
    },
  );
  assert.deepEqual(await services.listIntentsUseCase.execute(project.id), [first]);

  // 別Projectにはそれぞれ1件のActiveを持てる。
  const other = await services.createProjectUseCase.execute({ ...projectInput, name: "Other" });
  const otherIntent = await services.createIntentUseCase.execute(other.id, intentInput);
  assert.notEqual(otherIntent.id, first.id);
  await database.destroy();
});

test("DBの部分一意indexが、application層を経由しない2件目のActiveも拒否する", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const first = await services.createIntentUseCase.execute(project.id, intentInput);
  const insert = (status: string) =>
    sql`insert into intent (id, project_id, title, desired_state, status, created_at, updated_at)
      values (${crypto.randomUUID()}, ${project.id}, 't', 'd', ${status}, 1, 1)`.execute(database);

  await assert.rejects(insert("active"), /UNIQUE/);
  await assert.rejects(insert("draft"), /CHECK/);
  // 非activeは複数あってよい。
  await services.abandonIntentUseCase.execute(project.id, first.id);
  await insert("abandoned");
  await insert("achieved");
  await insert("active");
  await database.destroy();
});

test("他ProjectのIntent IDは、取得・更新・放棄のいずれでもNOT_FOUNDで内容を露出せず変更もしない", async () => {
  const { database, services } = await setup();
  const projectA = await services.createProjectUseCase.execute(projectInput);
  const projectB = await services.createProjectUseCase.execute({ ...projectInput, name: "B" });
  const intentA = await services.createIntentUseCase.execute(projectA.id, intentInput);

  await assert.rejects(services.getIntentUseCase.execute(projectB.id, intentA.id), codeOf("NOT_FOUND"));
  await assert.rejects(
    services.updateIntentUseCase.execute(projectB.id, intentA.id, { title: "Hijacked" }),
    codeOf("NOT_FOUND"),
  );
  await assert.rejects(
    services.abandonIntentUseCase.execute(projectB.id, intentA.id, { reason: "x" }),
    codeOf("NOT_FOUND"),
  );
  assert.deepEqual(await services.getIntentUseCase.execute(projectA.id, intentA.id), intentA);
  assert.deepEqual(await services.listIntentsUseCase.execute(projectB.id), []);
  await database.destroy();
});

test("存在しないProjectと存在しないIntentはNOT_FOUNDで、メッセージから区別できる", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const notFoundMessage = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      assert.equal((error as { code?: string }).code, "NOT_FOUND");
      return (error as Error).message;
    }
    return assert.fail("should reject");
  };

  assert.match(await notFoundMessage(services.createIntentUseCase.execute("missing", intentInput)), /^Project missing/);
  assert.match(await notFoundMessage(services.listIntentsUseCase.execute("missing")), /^Project missing/);
  assert.match(await notFoundMessage(services.getIntentUseCase.execute("missing", "x")), /^Project missing/);
  assert.match(
    await notFoundMessage(services.updateIntentUseCase.execute("missing", "x", { title: "t" })),
    /^Project missing/,
  );
  assert.match(await notFoundMessage(services.abandonIntentUseCase.execute("missing", "x")), /^Project missing/);
  assert.match(await notFoundMessage(services.getIntentUseCase.execute(project.id, "nope")), /^Intent nope/);
  assert.match(
    await notFoundMessage(services.updateIntentUseCase.execute(project.id, "nope", { title: "t" })),
    /^Intent nope/,
  );
  assert.match(await notFoundMessage(services.abandonIntentUseCase.execute(project.id, "nope")), /^Intent nope/);
  await database.destroy();
});

test("更新は指定した項目だけを変更し、completionDefinitionは空文字またはnullでクリアできる", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);
  const created = await services.createIntentUseCase.execute(project.id, intentInput);

  const renamed = await services.updateIntentUseCase.execute(project.id, created.id, { title: " New title " });
  assert.equal(renamed.id, created.id);
  assert.equal(renamed.title, "New title");
  assert.equal(renamed.desiredState, created.desiredState);
  assert.equal(renamed.completionDefinition, created.completionDefinition);
  assert.equal(renamed.createdAt, created.createdAt);
  assert.ok(renamed.updatedAt >= created.updatedAt);

  const cleared = await services.updateIntentUseCase.execute(project.id, created.id, { completionDefinition: "" });
  assert.equal(cleared.completionDefinition, null);
  assert.equal(cleared.title, "New title");
  assert.equal(cleared.desiredState, created.desiredState);

  await services.updateIntentUseCase.execute(project.id, created.id, { completionDefinition: "Done when X" });
  const nulled = await services.updateIntentUseCase.execute(project.id, created.id, { completionDefinition: null });
  assert.equal(nulled.completionDefinition, null);

  for (const input of [{}, { title: " " }, { desiredState: "" }, { title: "x".repeat(101) }, null]) {
    await assert.rejects(
      services.updateIntentUseCase.execute(project.id, created.id, input),
      codeOf("VALIDATION_ERROR"),
      JSON.stringify(input),
    );
  }
  assert.deepEqual(await services.getIntentUseCase.execute(project.id, created.id), nulled);
  await database.destroy();
});

test("放棄は理由あり・なしでabandonedにし、以後は編集・再放棄できず、新しいIntentを作成できる", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute(projectInput);

  const first = await services.createIntentUseCase.execute(project.id, intentInput);
  const withReason = await services.abandonIntentUseCase.execute(project.id, first.id, { reason: " Wrong goal " });
  assert.equal(withReason.status, "abandoned");
  assert.equal(withReason.abandonedReason, "Wrong goal");
  assert.equal(withReason.title, first.title);

  await assert.rejects(
    services.updateIntentUseCase.execute(project.id, first.id, { title: "Edit after abandon" }),
    (error: { code?: string; details?: Record<string, string> }) => {
      assert.equal(error.code, "CONFLICT");
      assert.equal(error.details?.status, "abandoned");
      return true;
    },
  );
  await assert.rejects(services.abandonIntentUseCase.execute(project.id, first.id), codeOf("CONFLICT"));
  assert.deepEqual(await services.getIntentUseCase.execute(project.id, first.id), withReason);

  const second = await services.createIntentUseCase.execute(project.id, { title: "Second", desiredState: "Second" });
  const withoutReason = await services.abandonIntentUseCase.execute(project.id, second.id);
  assert.equal(withoutReason.status, "abandoned");
  assert.equal(withoutReason.abandonedReason, null);

  await assert.rejects(
    services.abandonIntentUseCase.execute(project.id, (await services.createIntentUseCase.execute(project.id, intentInput)).id, {
      reason: "x".repeat(2_001),
    }),
    codeOf("VALIDATION_ERROR"),
  );
  const listed = await services.listIntentsUseCase.execute(project.id);
  assert.equal(listed.length, 3);
  assert.equal(listed[0]?.status, "active");
  await database.destroy();
});

test("achievedへ遷移する公開操作は存在しない", async () => {
  const { database, services } = await setup();
  const names = Object.keys(services).filter((name) => name.includes("Intent"));
  assert.deepEqual(names.sort(), [
    "abandonIntentUseCase",
    "createIntentUseCase",
    "getIntentUseCase",
    "listIntentsUseCase",
    "updateIntentUseCase",
  ]);
  const project = await services.createProjectUseCase.execute(projectInput);
  const created = await services.createIntentUseCase.execute(project.id, intentInput);
  // statusを直接書き換える入力は、未知の項目として無視され、状態は変わらない。
  const updated = await services.updateIntentUseCase.execute(project.id, created.id, { title: "t", status: "achieved" });
  assert.equal(updated.status, "active");
  await database.destroy();
});
