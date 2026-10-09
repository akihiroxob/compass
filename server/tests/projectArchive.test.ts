import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp, seedLegacyProjectGrant, seedProjectWorkspaceGrant } from "./support/humanSession.ts";
import { requestIntentResearch } from "./support/intentResearch.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { SQLiteIntentRepository, SQLiteOutcomeRepository } from "@compass/direction";
import { SQLiteProjectRepository } from "@compass/organization";
import { SQLiteProjectGrantRepository } from "@compass/access";
import { cliUsage, runCli } from "../src/cli/runCli.ts";
import { asAccessDatabase, asDirectionDatabase, asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import {
  accessProjectReaders,
  directionProjectReaders,
  directionWorkspaceReaders,
  projectRepositoryReferenceFinder,
} from "../src/infrastructure/repository/contextAdapters.ts";

type App = ReturnType<typeof createApp>;
type Body = Record<string, any>;
type ToolResult = { isError?: boolean; structuredContent: Body };

const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [{ description: "duplicate_claim_count = 0", measurement: "Count duplicates", target: "= 0" }],
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
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

const json = async (response: Response): Promise<Body> => (await response.json()) as Body;

const readData = async (response: Response) => {
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const rpc = (app: App, body: object, principal?: string) =>
  app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify(body),
  });

const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> => {
  const response = await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }, principal);
  assert.equal(response.status, 200);
  return (await readData(response)).result;
};

/** Intent・Outcome・Grantを持つactiveなProjectを作る。 */
const seed = async (database: ReturnType<typeof createDatabase>, services: Awaited<ReturnType<typeof setup>>["services"]) => {
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Keep direction explicit" });
  const intent = await services.createIntentUseCase.execute(project.workspaceId, { title: "Intent", desiredState: "State" });
  const outcome = await services.createOutcomeUseCase.execute(project.workspaceId, intent.id, outcomeInput);
  // Direction Role（Workspace所有）のGrantと、archiveガードを検証する旧Project Grant fixtureの両方を置く。
  await seedProjectWorkspaceGrant(database, project.id, "strat-1", "strategist");
  await seedLegacyProjectGrant(database, project.id, "strat-1", "strategist");
  return { project, intent, outcome };
};

const archive = (app: App, projectId: string, body: unknown = { reason: "Superseded" }) =>
  send(app, "POST", `/api/projects/${projectId}/archive`, body);

const counts = async (database: Awaited<ReturnType<typeof setup>>["database"]) => {
  const count = async (table: "intent" | "outcome" | "success_criterion" | "project_grant") =>
    Number((await database.selectFrom(table).select((builder) => builder.fn.countAll().as("n")).executeTakeFirstOrThrow()).n);
  return { intent: await count("intent"), outcome: await count("outcome"), criterion: await count("success_criterion"), grant: await count("project_grant") };
};

test("AC-1 archiveはstatus・理由・日時を保存し、updatedAt=archivedAtで、再起動後も同じ", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-archive-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project } = await seed(first.database, first.services);
  assert.equal(project.status, "active");
  assert.equal(project.archivedAt, null);
  assert.equal(project.archiveReason, null);

  const response = await archive(first.app, project.id, { reason: "  Superseded by a new Project  " });
  assert.equal(response.status, 200);
  const archived = (await json(response)).project;
  assert.equal(archived.status, "archived");
  assert.equal(archived.archiveReason, "Superseded by a new Project");
  assert.equal(typeof archived.archivedAt, "number");
  assert.equal(archived.updatedAt, archived.archivedAt);
  assert.equal(archived.name, project.name);
  await first.database.destroy();

  const second = await setup(path);
  const fetched = (await json(await second.app.request(`/api/projects/${project.id}`))).project;
  assert.deepEqual(fetched, archived);
  await second.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("AC-2 理由なし・空白のみ・本文なしは400（path reason）でactiveのまま", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  for (const body of [{}, { reason: "" }, { reason: "   " }, { reason: "x".repeat(2_001) }, undefined]) {
    // archive()の既定引数はundefinedを置き換えるため、本文なしはsendを直接呼ぶ。
    const response = await send(app, "POST", `/api/projects/${project.id}/archive`, body);
    assert.equal(response.status, 400, JSON.stringify(body));
    const error = (await json(response)).error;
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.deepEqual(error.issues.map((issue: { path: string }) => issue.path), ["reason"]);
  }
  const malformed = await archive(app, project.id, "{not json");
  assert.equal(malformed.status, 400);
  const fetched = (await json(await app.request(`/api/projects/${project.id}`))).project;
  assert.equal(fetched.status, "active");
  assert.equal(fetched.archivedAt, null);
  assert.equal(fetched.archiveReason, null);
  await database.destroy();
});

test("AC-3 再archiveは409（projectStatus）で、理由・日時を上書きしない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  const first = (await json(await archive(app, project.id, { reason: "First" }))).project;
  const again = await archive(app, project.id, { reason: "Second" });
  assert.equal(again.status, 409);
  const error = (await json(again)).error;
  assert.equal(error.code, "CONFLICT");
  assert.equal(error.projectStatus, "archived");
  assert.match(error.message, new RegExp(`^Project ${project.id} is already archived`));
  assert.deepEqual((await json(await app.request(`/api/projects/${project.id}`))).project, first);
  await database.destroy();
});

test("AC-4 存在しないIDのarchiveは404。Web APIではMembership認可が入力検証より先", async () => {
  const { database, app } = await setup();
  const missing = await archive(app, "missing");
  assert.equal(missing.status, 404);
  assert.equal((await json(missing)).error.code, "NOT_FOUND");
  // Membershipの無い（存在しない）Projectは、入力を検証する前に404にしてProject IDの存在を漏らさない（Step 6）。
  assert.equal((await archive(app, "missing", { reason: " " })).status, 404);
  await database.destroy();
});

test("AC-5 archivedのProject更新は409で変更されず、statusでは復帰できない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  // active中は、statusだけのPATCHは更新項目なしの400。statusは他の未知の項目と同じく無視される。
  const ignored = await send(app, "PATCH", `/api/projects/${project.id}`, { status: "archived" });
  assert.equal(ignored.status, 400);
  const renamed = await send(app, "PATCH", `/api/projects/${project.id}`, { name: "Renamed", status: "archived", archiveReason: "x" });
  assert.equal(renamed.status, 200);
  assert.equal((await json(renamed)).project.status, "active");

  const archived = (await json(await archive(app, project.id))).project;
  for (const body of [{ name: "Changed" }, { name: "Changed", status: "active" }]) {
    const response = await send(app, "PATCH", `/api/projects/${project.id}`, body);
    assert.equal(response.status, 409, JSON.stringify(body));
    assert.equal((await json(response)).error.projectStatus, "archived");
  }
  assert.equal((await send(app, "PATCH", `/api/projects/${project.id}`, { status: "active" })).status, 400);
  assert.deepEqual((await json(await app.request(`/api/projects/${project.id}`))).project, archived);
  await database.destroy();
});

test("AC-6 archivedのIntent作成・更新・放棄は409。存在しないintentIdでも404でなく409", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seed(database, services);
  const before = (await json(await app.request(`/api/workspaces/${project.workspaceId}/intents/${intent.id}`))).intent;
  await archive(app, project.id);
  const base = `/api/workspaces/${project.workspaceId}/intents`;
  const attempts: [string, string, unknown][] = [
    ["POST", base, { title: "New", desiredState: "State" }],
    ["PATCH", `${base}/${intent.id}`, { title: "Changed" }],
    ["PATCH", `${base}/missing`, { title: "Changed" }],
    ["POST", `${base}/${intent.id}/abandon`, { reason: "x" }],
    ["POST", `${base}/missing/abandon`, {}],
  ];
  for (const [method, path, body] of attempts) {
    const response = await send(app, method, path, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    // 最後のProjectのarchiveで所属Workspaceもarchivedになり、DirectionはWorkspaceとして拒否される。
    assert.equal((await json(response)).error.workspaceStatus, "archived");
  }
  assert.deepEqual((await json(await app.request(`${base}/${intent.id}`))).intent, before);
  assert.equal((await json(await app.request(base))).intents.length, 1);
  await database.destroy();
});

test("AC-7 archivedのOutcome作成・更新・取消は固定項目を含めて409で、Outcomeは変わらない", async () => {
  const { database, services, app } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  await archive(app, project.id);
  const base = `/api/workspaces/${project.workspaceId}/intents/${intent.id}/outcomes`;
  const attempts: [string, string, unknown][] = [
    ["POST", base, outcomeInput],
    ["PATCH", `${base}/${outcome.id}`, { title: "Changed" }],
    ["PATCH", `${base}/${outcome.id}`, { description: "fixed field" }],
    ["PATCH", `${base}/missing`, { title: "Changed" }],
    ["POST", `${base}/${outcome.id}/cancel`, { reason: "x" }],
    ["POST", `${base}/missing/cancel`, { reason: "x" }],
    ["POST", `/api/workspaces/${project.workspaceId}/intents/missing/outcomes`, outcomeInput],
  ];
  for (const [method, path, body] of attempts) {
    const response = await send(app, method, path, body);
    assert.equal(response.status, 409, `${method} ${path}`);
    // 最後のProjectのarchiveで所属Workspaceもarchivedになり、DirectionはWorkspaceとして拒否される。
    assert.equal((await json(response)).error.workspaceStatus, "archived");
  }
  const fetched = (await json(await app.request(`${base}/${outcome.id}`))).outcome;
  assert.deepEqual(fetched, JSON.parse(JSON.stringify(outcome)));
  assert.equal((await json(await app.request(base))).outcomes.length, 1);
  await database.destroy();
});

test("AC-8 archivedのGrant発行・取消はWeb APIとCLIで409。grants一覧は成功する", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  await archive(app, project.id);
  const grants = `/api/projects/${project.id}/grants`;

  const issued = await send(app, "POST", grants, { principalId: "strat-2", role: "manager" });
  assert.equal(issued.status, 409);
  assert.equal((await json(issued)).error.projectStatus, "archived");
  const revoked = await send(app, "DELETE", `${grants}/strategist/strat-1`);
  assert.equal(revoked.status, 409);
  // 既存Grantの再発行も、副作用がなくても書込として拒否する。
  assert.equal((await send(app, "POST", grants, { principalId: "strat-1", role: "manager" })).status, 409);
  assert.equal((await send(app, "POST", grants, { principalId: "runtime-1", role: "runtime" })).status, 409);
  assert.equal((await send(app, "DELETE", `${grants}/runtime/runtime-1`)).status, 409);
  // 新規Role-scope不一致は入力エラー。旧Roleの取消はarchiveガードを適用する。
  assert.equal((await send(app, "POST", grants, { principalId: "evaluator-1", role: "evaluator" })).status, 400);
  assert.equal((await send(app, "DELETE", `${grants}/evaluator/evaluator-1`)).status, 409);

  const cliGrant = await runCli(["grant", project.id, "strat-2", "manager"], services);
  assert.equal(cliGrant.exitCode, 1);
  assert.equal(JSON.parse(cliGrant.stderr).error.code, "CONFLICT");
  const cliRevoke = await runCli(["revoke", project.id, "strat-1", "strategist"], services);
  assert.equal(cliRevoke.exitCode, 1);
  assert.equal(JSON.parse(cliRevoke.stderr).error.code, "CONFLICT");

  const listed = (await json(await app.request(grants))).grants;
  assert.deepEqual(listed.map((grant: { principalId: string }) => grant.principalId), ["strat-1"]);
  const cliList = await runCli(["grants", project.id], services);
  assert.equal(cliList.exitCode, 0);
  assert.equal(JSON.parse(cliList.stdout).grants.length, 1);
  await database.destroy();
});

test("AC-9 archivedでもProject詳細・Intent・Outcome・Grantの参照はarchive前と同じ内容で成功する", async () => {
  const { database, services, app } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  const paths = [
    `/api/workspaces/${project.workspaceId}/intents`,
    `/api/workspaces/${project.workspaceId}/intents/${intent.id}`,
    `/api/workspaces/${project.workspaceId}/intents/${intent.id}/outcomes`,
    `/api/workspaces/${project.workspaceId}/intents/${intent.id}/outcomes/${outcome.id}`,
    `/api/projects/${project.id}/grants`,
  ];
  const before = await Promise.all(paths.map(async (path) => json(await app.request(path))));
  await archive(app, project.id);
  for (const [index, path] of paths.entries()) {
    const response = await app.request(path);
    assert.equal(response.status, 200, path);
    assert.deepEqual(await json(response), before[index], path);
  }
  const detail = await app.request(`/api/projects/${project.id}`);
  assert.equal(detail.status, 200);
  assert.equal((await json(detail)).project.status, "archived");
  await database.destroy();
});

test("AC-10 一覧はactiveのみ、?status=archivedでarchivedのみ（新しい順）。それ以外の値は400", async () => {
  const { database, services, app } = await setup();
  const active = await services.createProjectUseCase.execute({ name: "Active", mission: "m" });
  const first = await services.createProjectUseCase.execute({ name: "First", mission: "m" });
  const second = await services.createProjectUseCase.execute({ name: "Second", mission: "m" });
  await archive(app, first.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  await archive(app, second.id);

  const names = async (query: string) =>
    (await json(await app.request(`/api/projects${query}`))).projects.map((project: { name: string }) => project.name);
  assert.deepEqual(await names(""), ["Active"]);
  assert.deepEqual(await names("?status=active"), ["Active"]);
  assert.deepEqual(await names("?status=archived"), ["Second", "First"]);
  for (const query of ["?status=all", "?status=", "?status=ARCHIVED"]) {
    const response = await app.request(`/api/projects${query}`);
    assert.equal(response.status, 400, query);
    assert.deepEqual((await json(response)).error.issues.map((issue: { path: string }) => issue.path), ["status"]);
  }
  assert.ok(active);
  await database.destroy();
});

test("AC-11 Repositoryを直接呼んでも、archivedのProjectには何も書かず'project_archived'を返す", async () => {
  const { database, services } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  const before = await counts(database);
  const projectBefore = await services.getProjectUseCase.execute(project.id);

  const projects = new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder);
  const intents = new SQLiteIntentRepository(asDirectionDatabase(database), directionWorkspaceReaders);
  const outcomes = new SQLiteOutcomeRepository(asDirectionDatabase(database), directionWorkspaceReaders);
  const grants = new SQLiteProjectGrantRepository(asAccessDatabase(database), accessProjectReaders);
  const archived = { kind: "project_archived" };
  assert.deepEqual(await projects.update(project.id, { name: "Changed" }), archived);
  assert.deepEqual(await intents.create(project.workspaceId, { title: "T", desiredState: "S", completionDefinition: null }), { kind: "workspace_archived" });
  assert.deepEqual(await intents.update(project.workspaceId, intent.id, { title: "Changed" }), { kind: "workspace_archived" });
  assert.deepEqual(await intents.abandon(project.workspaceId, intent.id, "x"), { kind: "workspace_archived" });
  assert.deepEqual(await outcomes.create(project.workspaceId, intent.id, { ...outcomeInput, hypothesis: null, successCriteria: [{ description: "d", measurement: "m", target: null }] }), { kind: "workspace_archived" });
  assert.deepEqual(await outcomes.update(project.workspaceId, intent.id, outcome.id, { title: "Changed" }), { kind: "workspace_archived" });
  assert.deepEqual(await outcomes.cancel(project.workspaceId, intent.id, outcome.id, "x"), { kind: "workspace_archived" });
  assert.deepEqual(await grants.grant(project.id, "strat-2", "strategist"), archived);
  assert.deepEqual(await grants.revoke(project.id, "strat-1", "strategist"), archived);
  assert.deepEqual(await projects.archive(project.id, "again"), { kind: "already_archived" });

  assert.deepEqual(await counts(database), before);
  assert.deepEqual(await services.getProjectUseCase.execute(project.id), projectBefore);
  assert.equal((await services.getIntentUseCase.execute(project.workspaceId, intent.id)).title, "Intent");
  await database.destroy();
});

test("AC-12 archiveは子データを変更しない。activeなIntentはactiveのまま、Outcomeも取消されない", async () => {
  const { database, services } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  const before = await counts(database);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });

  assert.deepEqual(await counts(database), before);
  assert.deepEqual(await services.getIntentUseCase.execute(project.workspaceId, intent.id), intent);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id), outcome);
  assert.equal((await services.getIntentUseCase.execute(project.workspaceId, intent.id)).status, "active");
  assert.equal((await services.listProjectGrantsUseCase.execute(project.id)).length, 1);
  await database.destroy();
});

test("AC-13 archive導入前のDBは、initializeSchemaを2回実行してもエラーなくactiveへ移行し、子データは不変", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-archive-migration-"));
  const path = join(directory, "test.db");
  const legacy = await setup(path);
  const { project, intent, outcome } = await seed(legacy.database, legacy.services);
  // archive導入前のproject tableへ戻す。
  for (const column of ["status", "archived_at", "archive_reason"]) {
    await sql.raw(`alter table project drop column ${column}`).execute(legacy.database);
  }
  const legacyColumns = (await sql<{ name: string }>`select name from pragma_table_info('project')`.execute(legacy.database)).rows;
  assert.ok(!legacyColumns.some(({ name }) => name === "status"));
  const before = await counts(legacy.database);
  await legacy.database.destroy();

  const database = createDatabase(path);
  await initializeSchema(database);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const migrated = await services.getProjectUseCase.execute(project.id);
  assert.equal(migrated.status, "active");
  assert.equal(migrated.archivedAt, null);
  assert.equal(migrated.archiveReason, null);
  assert.equal(migrated.name, project.name);
  assert.deepEqual(await counts(database), before);
  assert.deepEqual(await services.getIntentUseCase.execute(project.workspaceId, intent.id), intent);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id), outcome);
  assert.deepEqual((await services.listProjectsUseCase.execute()).map((item) => item.id), [project.id]);

  const archived = await services.archiveProjectUseCase.execute(project.id, { reason: "After migration" });
  assert.equal(archived.status, "archived");
  await database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("statusのcheck制約は、active・archived以外の値を保存させない", async () => {
  const { database, services } = await setup();
  const { project } = await seed(database, services);
  await assert.rejects(() => sql`update project set status = 'paused' where id = ${project.id}`.execute(database));
  await database.destroy();
});

test("AC-14 archivedでも読取のMCP toolは成功し、Project.statusがarchivedになる", async () => {
  const { database, services, app } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  await requestIntentResearch(services, project.workspaceId, intent.id);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });

  const got = await callTool(app, "get_project", { projectId: project.id });
  assert.equal(got.isError, undefined);
  assert.equal(got.structuredContent.status, "archived");
  assert.equal(got.structuredContent.archiveReason, "Done");
  assert.equal((await callTool(app, "list_intents", { workspaceId: project.workspaceId })).structuredContent.intents.length, 1);
  assert.equal((await callTool(app, "get_intent", { workspaceId: project.workspaceId, intentId: intent.id })).isError, undefined);
  assert.equal((await callTool(app, "list_outcomes", { workspaceId: project.workspaceId, intentId: intent.id })).structuredContent.outcomes.length, 1);
  assert.equal(
    (await callTool(app, "get_outcome", { workspaceId: project.workspaceId, intentId: intent.id, outcomeId: outcome.id })).isError,
    undefined,
  );
  const context = await callTool(app, "get_strategist_context", { workspaceId: project.workspaceId }, "strat-1");
  assert.equal(context.isError, undefined);
  assert.equal(context.structuredContent.workspace.status, "archived");
  assert.equal(context.structuredContent.activeIntent.id, intent.id);
  const research = context.structuredContent.research as { requests: { id: string }[] };
  assert.equal(research.requests.length, 1);
  const requestDetail = await callTool(
    app,
    "get_research_request",
    { workspaceId: project.workspaceId, requestId: research.requests[0]!.id },
    "strat-1",
  );
  assert.equal(requestDetail.isError, undefined);
  assert.equal(requestDetail.structuredContent.request.id, research.requests[0]!.id);
  await database.destroy();
});

test("AC-15 archivedの書込MCP toolはisErrorのCONFLICT（projectStatus / workspaceStatus）。認証・Roleの拒否が先", async () => {
  const { database, services, app } = await setup();
  const { project, intent, outcome } = await seed(database, services);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  const ids = { workspaceId: project.workspaceId, intentId: intent.id };

  const writes: [string, object, string | undefined][] = [
    ["update_project", { projectId: project.id, name: "Changed" }, undefined],
    ["create_intent", { workspaceId: project.workspaceId, title: "T", desiredState: "S" }, undefined],
    ["update_intent", { ...ids, title: "Changed" }, undefined],
    ["abandon_intent", { ...ids, reason: "x" }, undefined],
    ["create_outcome", { ...ids, ...outcomeInput }, "strat-1"],
    ["update_outcome", { ...ids, outcomeId: outcome.id, title: "Changed" }, "strat-1"],
    ["update_outcome", { ...ids, outcomeId: outcome.id, description: "fixed" }, "strat-1"],
    ["cancel_outcome", { ...ids, outcomeId: outcome.id, reason: "x" }, "strat-1"],
    ["set_outcome_target", { workspaceId: project.workspaceId, outcomeId: outcome.id, projectId: project.id }, "strat-1"],
    ["unset_outcome_target", { workspaceId: project.workspaceId, outcomeId: outcome.id, projectId: project.id }, "strat-1"],
  ];
  for (const [name, args, principal] of writes) {
    const result = await callTool(app, name, args, principal);
    assert.equal(result.isError, true, name);
    assert.equal(result.structuredContent.error.code, "CONFLICT", name);
    // Project管理はprojectStatus、Workspace Direction（最後のProjectのarchiveでWorkspaceもarchived）はworkspaceStatus。
    const status = name === "update_project" ? result.structuredContent.error.projectStatus : result.structuredContent.error.workspaceStatus;
    assert.equal(status, "archived", name);
  }

  const unauthenticated = await callTool(app, "create_outcome", { ...ids, ...outcomeInput });
  assert.equal(unauthenticated.structuredContent.error.code, "UNAUTHENTICATED");
  const forbidden = await callTool(app, "create_outcome", { ...ids, ...outcomeInput }, "someone-else");
  assert.equal(forbidden.structuredContent.error.code, "FORBIDDEN");
  const strategistUpdate = await callTool(app, "update_project", { projectId: project.id, name: "x" }, "strat-1");
  assert.equal(strategistUpdate.structuredContent.error.code, "FORBIDDEN");

  assert.equal((await services.getProjectUseCase.execute(project.id)).name, "Compass");
  await database.destroy();
});

test("AC-16 MCPにarchive・delete・restore系のtoolは無く、list_projectsはactiveのみで引数を持たない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  const archivedProject = await services.createProjectUseCase.execute({ name: "Old", mission: "m" });
  await services.archiveProjectUseCase.execute(archivedProject.id, { reason: "Done" });

  const listed = await readData(await rpc(app, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
  const tools = listed.result.tools as { name: string; inputSchema: { properties?: object } }[];
  assert.equal(tools.filter(({ name }) => /archive|delete|remove|restore|unarchive|resume/i.test(name.replace("abandon_intent", ""))).length, 0);
  assert.deepEqual(
    tools.map(({ name }) => name).sort(),
    [
      "abandon_intent", "ack_runtime_event", "cancel_outcome", "complete_research_request", "create_adr_handoff_request",
      "create_direction_decision", "create_intent",
      "create_outcome", "create_project", "decide_next_outcome", "fetch_runtime_events",
      "get_intent", "get_orchestration_state", "get_outcome", "get_project", "get_research_request", "get_researcher_context", "get_role_instructions", "get_role_context", "list_skills", "get_skill_context",
      "get_outcome_execution_summary", "get_evaluator_context", "record_outcome_evaluation", "get_strategist_context", "list_adr_references", "list_intents", "list_outcomes", "list_projects",
      "list_research_requests", "record_adr_reference",
      // Target Projectの設定・解除はOutcomeとProjectの関連だけで、Projectのarchive・削除ではない。
      "list_outcome_targets", "list_outcome_target_work", "list_outcome_target_executions", "set_outcome_target", "unset_outcome_target",
      "record_execution_evidence", "register_research_result", "register_research_synthesis", "update_intent", "update_outcome", "update_project",
      // Execution（Story / Task / Claim）。archive・delete・restoreに当たるtoolは無い（cancelは取消であり削除ではない）。
      "accept_task", "add_task_comment", "cancel_story", "cancel_task", "claim_acceptance", "claim_review", "claim_task",
      "complete_story", "complete_task", "edit_story", "edit_task", "get_outcome_handoff_context", "issue_story", "issue_task", "list_changes",
      "list_stories", "list_task_comments", "list_tasks", "reject_task", "release_claim", "renew_claim", "reviewed_task",
      // Activityは追記だけで、削除・書換のtoolは無い（訂正は追記）。
      "get_activity", "list_activities", "record_activity",
      "get_workspace_activity", "list_workspace_activities", "record_workspace_activity",
    ].sort(),
  );
  const listTool = tools.find(({ name }) => name === "list_projects");
  assert.deepEqual(Object.keys(listTool?.inputSchema.properties ?? {}), []);

  const projects = (await callTool(app, "list_projects", {})).structuredContent.projects as { id: string }[];
  assert.deepEqual(projects.map((item) => item.id), [project.id]);
  await database.destroy();
});

test("AC-17 CLIにarchive・deleteのコマンドは無く、Grantの発行・取消Roleを案内する", async () => {
  const { database, services } = await setup();
  assert.equal(
    cliUsage,
    [
      "Usage:",
      "  npm run cli -- grant  <projectId> <AgentName> <role>",
      "  npm run cli -- revoke <projectId> <AgentName> <role>",
      "  npm run cli -- grants <projectId>",
      "grant roles: manager, worker, reviewer, runtime",
      "revoke roles: strategist, researcher, manager, worker, reviewer, evaluator, runtime",
    ].join("\n"),
  );
  const { project } = await seed(database, services);
  for (const command of ["archive", "delete", "unarchive", "restore"]) {
    const result = await runCli([command, project.id, "reason"], services);
    assert.equal(result.exitCode, 2, command);
    assert.match(result.stderr, /unknown command/);
  }
  assert.equal((await services.getProjectUseCase.execute(project.id)).status, "active");
  await database.destroy();
});

test("AC-18 Project応答は既存項目を保ち、所属workspaceId・status・archivedAt・archiveReasonが追加されるだけ", async () => {
  const { database, app } = await setup();
  const created = await send(app, "POST", "/api/projects", { name: "Compass", mission: "m", status: "archived", archiveReason: "x" });
  assert.equal(created.status, 201);
  const project = (await json(created)).project;
  assert.deepEqual(Object.keys(project), [
    "id", "workspaceId", "name", "description", "mission", "vision", "principles", "constraints", "repositories", "resources",
    "createdAt", "updatedAt", "status", "archivedAt", "archiveReason",
  ]);
  assert.equal(project.status, "active");
  assert.equal(project.archivedAt, null);
  assert.equal(project.archiveReason, null);

  const updated = (await json(await send(app, "PATCH", `/api/projects/${project.id}`, { name: "Renamed" }))).project;
  assert.deepEqual(Object.keys(updated), Object.keys(project));
  assert.equal(updated.status, "active");
  const listed = (await json(await app.request("/api/projects"))).projects[0];
  assert.deepEqual(Object.keys(listed), Object.keys(project));
  await database.destroy();
});

test("AC-19 Project削除・復帰用のpathは未定義のAPIと同じ404で、Projectは変わらない", async () => {
  const { database, services, app } = await setup();
  const { project } = await seed(database, services);
  const archived = (await json(await archive(app, project.id))).project;
  const attempts: [string, string][] = [
    ["DELETE", `/api/projects/${project.id}`],
    ["POST", `/api/projects/${project.id}/unarchive`],
    ["POST", `/api/projects/${project.id}/restore`],
    ["DELETE", `/api/projects/${project.id}/archive`],
  ];
  for (const [method, path] of attempts) {
    const response = await send(app, method, path, {});
    assert.equal(response.status, 404, `${method} ${path}`);
    assert.equal((await json(response)).error.code, "NOT_FOUND");
  }
  assert.deepEqual((await json(await app.request(`/api/projects/${project.id}`))).project, archived);
  assert.deepEqual(await counts(database), { intent: 1, outcome: 1, criterion: 1, grant: 1 });
  await database.destroy();
});
