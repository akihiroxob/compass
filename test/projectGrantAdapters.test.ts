import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { runCli } from "../src/presentation/cli/runCli.ts";

type App = ReturnType<typeof createApp>;
type GrantBody = { grant: { projectId: string; principalId: string; role: string; createdAt: number }; created: boolean };
type ErrorBody = { error: { code: string; message: string; issues?: { path: string }[] } };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
};

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });

const createProject = async (app: App, name = "Compass") =>
  ((await (await send(app, "POST", "/api/projects", { name, mission: "Mission" })).json()) as { project: { id: string } }).project.id;

const grantsPath = (projectId: string) => `/api/projects/${projectId}/grants`;

test("Web APIでGrantを発行（201）・再発行（200）・一覧・取消でき、再発行は重複せずcreatedAtも不変", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);

  const created = await send(app, "POST", grantsPath(projectId), { principalId: "strat-1", role: "strategist" });
  assert.equal(created.status, 201);
  const first = (await created.json()) as GrantBody;
  assert.equal(first.created, true);
  assert.deepEqual(Object.keys(first.grant).sort(), ["createdAt", "principalId", "projectId", "role"]);

  const again = await send(app, "POST", grantsPath(projectId), { principalId: "strat-1", role: "strategist" });
  assert.equal(again.status, 200);
  const second = (await again.json()) as GrantBody;
  assert.equal(second.created, false);
  assert.deepEqual(second.grant, first.grant);

  const listed = (await (await app.request(grantsPath(projectId))).json()) as { grants: unknown[] };
  assert.deepEqual(listed.grants, [first.grant]);

  const revoked = await send(app, "DELETE", `${grantsPath(projectId)}/strategist/strat-1`);
  assert.equal(revoked.status, 200);
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.deepEqual(await (await app.request(grantsPath(projectId))).json(), { grants: [] });

  const revokedAgain = await send(app, "DELETE", `${grantsPath(projectId)}/strategist/strat-1`);
  assert.equal(revokedAgain.status, 200);
  assert.deepEqual(await revokedAgain.json(), { revoked: false });
  await database.destroy();
});

test("取消は別ProjectのGrantに影響せず、URLエンコードされたprincipalIdを扱える", async () => {
  const { database, app } = await setup();
  const projectP = await createProject(app, "P");
  const projectQ = await createProject(app, "Q");
  for (const projectId of [projectP, projectQ]) {
    await send(app, "POST", grantsPath(projectId), { principalId: "team/agent 1", role: "strategist" });
  }
  const revoked = await send(app, "DELETE", `${grantsPath(projectP)}/strategist/${encodeURIComponent("team/agent 1")}`);
  assert.deepEqual(await revoked.json(), { revoked: true });
  assert.deepEqual(await (await app.request(grantsPath(projectP))).json(), { grants: [] });
  const remaining = (await (await app.request(grantsPath(projectQ))).json()) as { grants: { principalId: string }[] };
  assert.deepEqual(remaining.grants.map((grant) => grant.principalId), ["team/agent 1"]);
  await database.destroy();
});

test("存在しないProjectは発行・一覧・取消とも404、不正な入力は400 VALIDATION_ERROR（path付き）", async () => {
  const { database, app } = await setup();
  const projectId = await createProject(app);

  for (const response of [
    await send(app, "POST", grantsPath("missing"), { principalId: "a", role: "strategist" }),
    await app.request(grantsPath("missing")),
    await send(app, "DELETE", `${grantsPath("missing")}/strategist/a`),
  ]) {
    assert.equal(response.status, 404);
    const body = (await response.json()) as ErrorBody;
    assert.equal(body.error.code, "NOT_FOUND");
    assert.equal(body.error.message, "Project missing was not found");
  }

  const invalid: [unknown, string][] = [
    [{ principalId: "   ", role: "strategist" }, "principalId"],
    [{ principalId: "x".repeat(101), role: "strategist" }, "principalId"],
    [{ principalId: "bad\u0007", role: "strategist" }, "principalId"],
    [{ principalId: "a", role: "" }, "role"],
    [{ principalId: "a", role: "admin" }, "role"],
    [{ principalId: "a", role: "Strategist" }, "role"],
    [{ principalId: "a" }, "role"],
  ];
  for (const [body, path] of invalid) {
    const response = await send(app, "POST", grantsPath(projectId), body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = ((await response.json()) as ErrorBody).error;
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.issues?.map((issue) => issue.path), [path]);
  }
  const malformed = await send(app, "POST", grantsPath(projectId), "{");
  assert.equal(malformed.status, 400);
  assert.equal(((await malformed.json()) as ErrorBody).error.code, "VALIDATION_ERROR");

  const badRole = await send(app, "DELETE", `${grantsPath(projectId)}/admin/a`);
  assert.equal(badRole.status, 400);
  assert.deepEqual(((await badRole.json()) as ErrorBody).error.issues?.map((issue) => issue.path), ["role"]);
  assert.deepEqual(await (await app.request(grantsPath(projectId))).json(), { grants: [] });
  await database.destroy();
});

test("CORSはBearerのMCP・Runtime APIだけに許し、Session Cookieで認証するHuman向けAPIには付けない", async () => {
  const { database, app } = await setup();
  const preflight = (path: string, method: string) =>
    app.request(path, {
      method: "OPTIONS",
      headers: { Origin: "http://evil.example", "Access-Control-Request-Method": method, "Access-Control-Request-Headers": "authorization,content-type" },
    });
  const human = await preflight("/api/projects/x/grants/strategist/a", "DELETE");
  assert.equal(human.headers.get("Access-Control-Allow-Origin"), null);
  for (const path of ["/mcp", "/api/projects/x/runtime-events", "/api/projects/x/runtime-events/e/ack", "/api/projects/x/outcomes/o/execution-evidence"]) {
    const bearer = await preflight(path, "POST");
    assert.equal(bearer.headers.get("Access-Control-Allow-Origin"), "*", path);
    assert.match((bearer.headers.get("Access-Control-Allow-Headers") ?? "").toLowerCase(), /authorization/, path);
  }
  const projectId = await createProject(app);
  assert.equal((await app.request(`/api/projects/${projectId}`)).status, 200);
  assert.equal((await app.request("/health")).status, 200);
  await database.destroy();
});

test("runCli: grant / grants / revoke がAPIと同じ形のJSONと終了コードを返す", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Mission" });

  const granted = await runCli(["grant", project.id, "strat-1", "strategist"], services);
  assert.equal(granted.exitCode, 0);
  const grantedBody = JSON.parse(granted.stdout) as GrantBody;
  assert.equal(grantedBody.created, true);
  assert.equal(grantedBody.grant.principalId, "strat-1");

  const repeated = JSON.parse((await runCli(["grant", project.id, "strat-1", "strategist"], services)).stdout) as GrantBody;
  assert.equal(repeated.created, false);

  const listed = await runCli(["grants", project.id], services);
  assert.equal(listed.exitCode, 0);
  assert.deepEqual(JSON.parse(listed.stdout), { grants: [grantedBody.grant] });

  const revoked = await runCli(["revoke", project.id, "strat-1", "strategist"], services);
  assert.equal(revoked.exitCode, 0);
  assert.deepEqual(JSON.parse(revoked.stdout), { revoked: true });
  const revokedAgain = await runCli(["revoke", project.id, "strat-1", "strategist"], services);
  assert.equal(revokedAgain.exitCode, 0);
  assert.deepEqual(JSON.parse(revokedAgain.stdout), { revoked: false });
  assert.deepEqual(JSON.parse((await runCli(["grants", project.id], services)).stdout), { grants: [] });
  await database.destroy();
});

test("runCli: 引数不足・未知のコマンドは終了コード2、未知のProject・不正入力は標準エラーのerrorと終了コード1", async () => {
  const { database, services } = await setup();
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Mission" });

  for (const argv of [[], ["unknown"], ["grant"], ["grant", project.id, "strat-1"], ["revoke", project.id], ["grants"], ["grants", project.id, "extra"]]) {
    const result = await runCli(argv, services);
    assert.equal(result.exitCode, 2, argv.join(" "));
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
  }

  const missing = await runCli(["grant", "missing", "strat-1", "strategist"], services);
  assert.equal(missing.exitCode, 1);
  assert.equal(missing.stdout, "");
  const missingBody = JSON.parse(missing.stderr) as ErrorBody;
  assert.equal(missingBody.error.code, "NOT_FOUND");
  assert.match(missingBody.error.message, /Project missing/);

  const invalid = await runCli(["grant", project.id, "strat-1", "admin"], services);
  assert.equal(invalid.exitCode, 1);
  const invalidBody = JSON.parse(invalid.stderr) as ErrorBody;
  assert.equal(invalidBody.error.code, "VALIDATION_ERROR");
  assert.deepEqual(invalidBody.error.issues?.map((issue) => issue.path), ["role"]);
  assert.equal((await runCli(["grant", project.id, "  ", "strategist"], services)).exitCode, 1);
  await database.destroy();
});

test("npm run cliの実体はサーバー無しで空DBに対し、Project作成後のGrantを発行・一覧・取消できる（再起動後も保持）", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-cli-"));
  const path = join(directory, "cli.db");
  const database = createDatabase(path);
  await initializeSchema(database);
  const project = await createApplicationServices(database).createProjectUseCase.execute({ name: "Compass", mission: "Mission" });
  await database.destroy();

  const run = async (...args: string[]) => {
    try {
      const { stdout } = await promisify(execFile)("node", ["--import", "tsx", "src/presentation/cli/main.ts", ...args], {
        env: { ...process.env, COMPASS_DB_PATH: path },
      });
      return { code: 0, stdout, stderr: "" };
    } catch (error) {
      const failed = error as { code: number; stdout: string; stderr: string };
      return { code: failed.code, stdout: failed.stdout, stderr: failed.stderr };
    }
  };

  const granted = await run("grant", project.id, "strat-1", "strategist");
  assert.equal(granted.code, 0);
  assert.equal((JSON.parse(granted.stdout) as GrantBody).created, true);
  // 別プロセス（=再起動後）でも同じGrantが読める。
  const listed = JSON.parse((await run("grants", project.id)).stdout) as { grants: { principalId: string }[] };
  assert.deepEqual(listed.grants.map((grant) => grant.principalId), ["strat-1"]);
  assert.equal((await run("grant", project.id)).code, 2);
  const missing = await run("grants", "missing");
  assert.equal(missing.code, 1);
  assert.equal((JSON.parse(missing.stderr) as ErrorBody).error.code, "NOT_FOUND");
  assert.deepEqual(JSON.parse((await run("revoke", project.id, "strat-1", "strategist")).stdout), { revoked: true });
  assert.deepEqual(JSON.parse((await run("grants", project.id)).stdout), { grants: [] });
  await rm(directory, { recursive: true, force: true });
});
