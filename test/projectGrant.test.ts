import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database) };
};

const createProject = (services: Awaited<ReturnType<typeof setup>>["services"], name = "Compass") =>
  services.createProjectUseCase.execute({ name, mission: "Keep direction explicit" });

const codeOf = (code: string) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  return true;
};

const issuePaths = (error: unknown) => (error as { issues: { path: string }[] }).issues.map((issue) => issue.path);

test("Grantは発行でき、一覧に出て、再発行は重複せずcreatedAtも変わらない", async () => {
  const { database, services } = await setup();
  const project = await createProject(services);

  const first = await services.grantProjectRoleUseCase.execute(project.id, { principalId: "strat-1", role: "strategist" });
  assert.equal(first.created, true);
  assert.equal(first.grant.projectId, project.id);
  assert.equal(first.grant.principalId, "strat-1");
  assert.equal(first.grant.role, "strategist");

  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = await services.grantProjectRoleUseCase.execute(project.id, { principalId: "strat-1", role: "strategist" });
  assert.equal(second.created, false);
  assert.deepEqual(second.grant, first.grant);

  assert.deepEqual(await services.listProjectGrantsUseCase.execute(project.id), [first.grant]);
  await database.destroy();
});

test("principalIdはtrimされ、大文字小文字を区別し、一覧はprincipalIdの昇順", async () => {
  const { database, services } = await setup();
  const project = await createProject(services);
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "  b-agent ", role: "strategist" });
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "B-agent", role: "strategist" });
  await services.grantProjectRoleUseCase.execute(project.id, { principalId: "a-agent", role: "strategist" });
  const principals = (await services.listProjectGrantsUseCase.execute(project.id)).map((grant) => grant.principalId);
  assert.deepEqual(principals, ["B-agent", "a-agent", "b-agent"]);
  await database.destroy();
});

test("取消するとGrantが消え、再取消はrevoked:falseで、別ProjectのGrantに影響しない", async () => {
  const { database, services } = await setup();
  const projectP = await createProject(services, "P");
  const projectQ = await createProject(services, "Q");
  const input = { principalId: "strat-1", role: "strategist" };
  await services.grantProjectRoleUseCase.execute(projectP.id, input);
  await services.grantProjectRoleUseCase.execute(projectQ.id, input);

  assert.equal(await services.revokeProjectRoleUseCase.execute(projectP.id, input), true);
  assert.deepEqual(await services.listProjectGrantsUseCase.execute(projectP.id), []);
  assert.equal((await services.listProjectGrantsUseCase.execute(projectQ.id)).length, 1);
  assert.equal(await services.revokeProjectRoleUseCase.execute(projectP.id, input), false);
  await database.destroy();
});

test("存在しないProjectはNOT_FOUND、空・空白・101文字・制御文字のprincipalIdと不正roleはVALIDATION_ERROR", async () => {
  const { database, services } = await setup();
  const project = await createProject(services);
  const valid = { principalId: "strat-1", role: "strategist" };

  for (const run of [
    () => services.grantProjectRoleUseCase.execute("missing", valid),
    () => services.revokeProjectRoleUseCase.execute("missing", valid),
    () => services.listProjectGrantsUseCase.execute("missing"),
  ]) {
    await assert.rejects(run, (error) => {
      assert.equal((error as Error).message, "Project missing was not found");
      return codeOf("NOT_FOUND")(error);
    });
  }

  const invalidPrincipals = ["", "   ", "x".repeat(101), "bad\nname", "bad\u0000name", undefined, 1];
  for (const principalId of invalidPrincipals) {
    await assert.rejects(
      () => services.grantProjectRoleUseCase.execute(project.id, { ...valid, principalId }),
      (error) => {
        assert.deepEqual(issuePaths(error), ["principalId"]);
        return codeOf("VALIDATION_ERROR")(error);
      },
    );
  }
  for (const role of ["", "admin", "Strategist", "STRATEGIST", undefined, null]) {
    await assert.rejects(
      () => services.grantProjectRoleUseCase.execute(project.id, { ...valid, role }),
      (error) => {
        assert.deepEqual(issuePaths(error), ["role"]);
        return codeOf("VALIDATION_ERROR")(error);
      },
    );
    await assert.rejects(() => services.revokeProjectRoleUseCase.execute(project.id, { ...valid, role }), codeOf("VALIDATION_ERROR"));
  }
  await assert.rejects(() => services.grantProjectRoleUseCase.execute(project.id, null), codeOf("VALIDATION_ERROR"));
  assert.deepEqual(await services.listProjectGrantsUseCase.execute(project.id), []);
  // 入力検証は存在確認より先。不正入力は存在しないProjectでもVALIDATION_ERRORになる。
  await assert.rejects(() => services.grantProjectRoleUseCase.execute("missing", { ...valid, role: "admin" }), codeOf("VALIDATION_ERROR"));
  await database.destroy();
});

test("DBを閉じて同じfileで再起動してもGrantが保持され、initializeSchemaの再実行でも壊れない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-grant-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const project = await createProject(first.services);
  const { grant } = await first.services.grantProjectRoleUseCase.execute(project.id, { principalId: "strat-1", role: "strategist" });
  await first.database.destroy();

  const second = await setup(path);
  await initializeSchema(second.database);
  assert.deepEqual(await second.services.listProjectGrantsUseCase.execute(project.id), [grant]);
  await second.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("roleにDB check制約はなく、Projectと同じ外部キーで管理される（既存tableは変更されない）", async () => {
  const { database } = await setup();
  const columns = await database.introspection.getTables();
  const grantTable = columns.find((table) => table.name === "project_grant");
  assert.deepEqual(
    grantTable?.columns.map((column) => column.name),
    ["project_id", "principal_id", "role", "created_at"],
  );
  await assert.rejects(
    database.insertInto("project_grant").values({ project_id: "missing", principal_id: "a", role: "strategist", created_at: 1 }).execute(),
    /FOREIGN KEY/,
  );
  await database.destroy();
});
