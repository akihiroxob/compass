import assert from "node:assert/strict";
import test from "node:test";
import type { HumanActor } from "@compass/access";
import { sql } from "kysely";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * UI-E2: Agentの実行観測（`record_agent_run`・`GET /api/workspaces/:workspaceId/agent-runs`）。
 * 報告元（Agent Credential・Runtime Credential）とGrantでPrincipal・Role・scopeを確定し、再送・別scope・別Principalの書換えを防ぐ。
 * 認証情報を理由へ残さず、Activityへ書かない。runはテスト内の報告で、実Agentの実行・自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Run = { runId: string; principalId: string; role: string; scope: { kind: string; id: string }; status: string; observation: string; reason: string | null; observedAt: number; staleAt: number; endedAt: number | null; reporter: { kind: string; principalId: string }; workRef: { kind: string; id: string } | null };

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });
const postJson = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const callTool = async (app: App, args: object, bearer: string, activeRole?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${bearer}`,
      ...(activeRole ? { "X-Compass-Active-Role": activeRole } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "record_agent_run", arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};
const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent as { run: Run; recorded: boolean };
};
const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; conflict?: string };
};

const setup = async () => {
  let now = 1_800_000_000_000;
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => now);
  const web = createApp(services);
  const mcp = createApp(services, { humanAuth: { mode: "remote", publicOrigin: "https://compass.example" } });
  const owner = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const other = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  const second = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha ops" });
  const outside = await services.human.createWorkspaceProject.execute(actorOf(owner), other.id, { name: "Beta app" });
  const asOwner = requestAs(web, owner);
  const issue = async (scopePath: string, body: object) => {
    const response = await asOwner(`${scopePath}/credentials`, postJson({ expiresInDays: 30, ...body }));
    assert.equal(response.status, 201, await response.clone().text());
    return ((await response.json()) as { token: string }).token;
  };
  const grant = async (scopePath: string, principalId: string, role: string) =>
    assert.equal((await asOwner(`${scopePath}/grants`, postJson({ principalId, role }))).status, 201);
  const runsOf = async (query = "") => {
    const response = await asOwner(`/api/workspaces/${workspace.id}/agent-runs${query}`);
    assert.equal(response.status, 200);
    return (await response.json()) as { asOf: number; runs: Run[] };
  };
  return { database, services, web, mcp, owner, workspace, other, project, second, outside, issue, grant, runsOf, advance: (ms: number) => { now += ms; }, now: () => now };
};

test("Agent CredentialのRunnerは自分の実行だけを記録し、再送は冪等・終了理由の認証情報は伏字・Activityへ書かない", async () => {
  const kit = await setup();
  const { database, mcp, project, second, issue, grant, runsOf } = kit;
  try {
    await grant(`/api/projects/${project.id}`, "ralph-worker", "worker");
    await grant(`/api/projects/${second.id}`, "ralph-reviewer", "reviewer");
    const worker = await issue(`/api/projects/${project.id}`, { kind: "agent", principalId: "ralph-worker" });
    const reviewer = await issue(`/api/projects/${second.id}`, { kind: "agent", principalId: "ralph-reviewer" });
    const activities = async () => Number((await sql<{ count: number }>`select count(*) as count from activity`.execute(database)).rows[0].count);
    const activityBefore = await activities();
    const scope = { kind: "project", id: project.id };
    const started = { runId: "ralph-run-0001", scope, event: "started", source: "ralph", provider: "Bearer cmp_agent.abc.secretvalue", workRef: { kind: "task", id: "cmp_agent.abc.secretvalue" }, staleAfterSeconds: 600 };

    // activeRoleが無い・Grantの無いRole・発行scope外の記録は拒否する。
    assert.equal(errorOf(await callTool(mcp, started, worker)).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(mcp, started, worker, "reviewer")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(mcp, { ...started, scope: { kind: "project", id: second.id } }, worker, "worker")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(mcp, { ...started, principalId: "ralph-reviewer" }, worker, "worker")).code, "FORBIDDEN");

    const first = ok(await callTool(mcp, started, worker, "worker"));
    assert.equal(first.recorded, true);
    assert.doesNotMatch(JSON.stringify(first.run), /secretvalue/);
    assert.equal(first.run.principalId, "ralph-worker");
    assert.equal(first.run.role, "worker");
    assert.deepEqual(first.run.reporter, { kind: "agent", principalId: "ralph-worker" });
    assert.equal(first.run.observation, "running");
    // 同じrunの再送は重複しない。
    kit.advance(1_000);
    const resend = ok(await callTool(mcp, started, worker, "worker"));
    assert.equal(resend.recorded, false);
    assert.equal(resend.run.observedAt, first.run.observedAt);
    // 別Principal（別Project）のRunnerは、同じrun IDを上書きできない。
    const crossed = errorOf(await callTool(mcp, { ...started, scope: { kind: "project", id: second.id } }, reviewer, "reviewer"));
    assert.equal(crossed.code, "CONFLICT");
    assert.equal(crossed.conflict, "AGENT_RUN_IDENTITY_MISMATCH");

    kit.advance(60_000);
    const observed = ok(await callTool(mcp, { ...started, event: "observed" }, worker, "worker"));
    assert.equal(observed.run.observedAt, kit.now());
    assert.equal(observed.run.staleAt, kit.now() + 600_000);

    const finished = ok(await callTool(mcp, { ...started, event: "finished", result: "failed", reason: "exit 1: Authorization: Bearer cmp_agent.abc.secretvalue rejected (cmp_agent.abc.secretvalue)" }, worker, "worker"));
    assert.equal(finished.run.status, "failed");
    assert.equal(finished.run.observation, "failed");
    assert.doesNotMatch(finished.run.reason ?? "", /secretvalue/);
    assert.match(finished.run.reason ?? "", /exit 1/);
    // 同じ結果の再送は冪等、別の結果はCONFLICT、未開始のrunはNOT_FOUND。
    assert.equal(ok(await callTool(mcp, { ...started, event: "finished", result: "failed" }, worker, "worker")).recorded, false);
    assert.equal(errorOf(await callTool(mcp, { ...started, event: "finished", result: "succeeded" }, worker, "worker")).conflict, "AGENT_RUN_FINISHED");
    assert.equal(errorOf(await callTool(mcp, { ...started, runId: "ralph-run-missing", event: "observed" }, worker, "worker")).code, "NOT_FOUND");
    // 認証情報をrun IDにできない。
    assert.equal(errorOf(await callTool(mcp, { ...started, runId: "cmp_agent.abc.secretvalue" }, worker, "worker")).code, "VALIDATION_ERROR");

    const { runs } = await runsOf();
    assert.deepEqual(runs.map((run) => [run.runId, run.observation]), [["ralph-run-0001", "failed"]]);
    assert.doesNotMatch(JSON.stringify(runs), /secretvalue/);
    assert.equal(await activities(), activityBefore);
  } finally {
    await database.destroy();
  }
});

test("Runtime CredentialのRunnerは同じscopeでGrantを持つPrincipalの実行だけを記録できる", async () => {
  const kit = await setup();
  const { database, mcp, workspace, project, issue, grant, runsOf } = kit;
  try {
    await grant(`/api/workspaces/${workspace.id}`, "strategist-01", "strategist");
    await grant(`/api/projects/${project.id}`, "manager-01", "manager");
    const readOnly = await issue(`/api/workspaces/${workspace.id}`, { kind: "runtime", principalId: "orchestrator", scopes: ["runtime:state:read"] });
    const workspaceRuntime = await issue(`/api/workspaces/${workspace.id}`, { kind: "runtime", principalId: "orchestrator", scopes: ["runtime:state:read", "agent:run:write"] });
    const projectRuntime = await issue(`/api/projects/${project.id}`, { kind: "runtime", principalId: "orchestrator-p", scopes: ["agent:run:write"] });
    const workspaceScope = { kind: "workspace", id: workspace.id };
    const strategistRun = {
      runId: "orch-0001", scope: workspaceScope, event: "started", source: "orchestrator", principalId: "strategist-01", role: "strategist",
      workRef: { kind: "intent", id: "intent-1" }, staleAfterSeconds: 120,
    };

    assert.equal(errorOf(await callTool(mcp, strategistRun, readOnly, "runtime")).code, "FORBIDDEN");
    // Grantの無いPrincipal・scope外のRole・Principal未指定は拒否する。
    assert.equal(errorOf(await callTool(mcp, { ...strategistRun, principalId: "nobody" }, workspaceRuntime, "runtime")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(mcp, { ...strategistRun, principalId: "manager-01", role: "manager" }, workspaceRuntime, "runtime")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(mcp, { ...strategistRun, principalId: undefined }, workspaceRuntime, "runtime")).code, "FORBIDDEN");
    // Workspace Runtime CredentialでProjectの実行を記録しない（継承しない）。
    const managerRun = { ...strategistRun, runId: "orch-0002", scope: { kind: "project", id: project.id }, principalId: "manager-01", role: "manager", workRef: { kind: "outcome", id: "o-1" } };
    assert.equal(errorOf(await callTool(mcp, managerRun, workspaceRuntime, "runtime")).code, "FORBIDDEN");

    const recorded = ok(await callTool(mcp, strategistRun, workspaceRuntime, "runtime"));
    assert.deepEqual(recorded.run.reporter, { kind: "runtime", principalId: "orchestrator" });
    assert.deepEqual(recorded.run.workRef, { kind: "intent", id: "intent-1" });
    ok(await callTool(mcp, managerRun, projectRuntime, "runtime"));
    ok(await callTool(mcp, { ...managerRun, event: "finished", result: "succeeded" }, projectRuntime, "runtime"));

    // 報告が途絶えた実行中のrunは、読取時刻で観測途絶（stale）になる。
    kit.advance(121_000);
    const { asOf, runs } = await runsOf();
    assert.equal(asOf, kit.now());
    assert.deepEqual(runs.map((run) => [run.principalId, run.status, run.observation]).sort(), [["manager-01", "succeeded", "succeeded"], ["strategist-01", "running", "stale"]]);
  } finally {
    await database.destroy();
  }
});

test("実行観測の参照はWorkspace Membershipで認可し、Workspace・activeな所属Projectのrunだけを返す", async () => {
  const kit = await setup();
  const { database, web, mcp, workspace, other, project, outside, issue, grant, runsOf } = kit;
  try {
    await grant(`/api/projects/${project.id}`, "worker-01", "worker");
    await grant(`/api/projects/${outside.id}`, "worker-02", "worker");
    const inside = await issue(`/api/projects/${project.id}`, { kind: "agent", principalId: "worker-01" });
    const beyond = await issue(`/api/projects/${outside.id}`, { kind: "agent", principalId: "worker-02" });
    const run = (runId: string, projectId: string) => ({ runId, scope: { kind: "project", id: projectId }, event: "started", source: "ralph" });
    ok(await callTool(mcp, run("run-in-0001", project.id), inside, "worker"));
    kit.advance(1_000);
    ok(await callTool(mcp, { ...run("run-in-0001", project.id), event: "finished", result: "succeeded" }, inside, "worker"));
    kit.advance(1_000);
    ok(await callTool(mcp, run("run-in-0002", project.id), inside, "worker"));
    ok(await callTool(mcp, run("run-out-0001", outside.id), beyond, "worker"));

    // 一覧はPrincipal・scope・Roleごとの最新、principalId指定は新しい順の履歴。
    assert.deepEqual((await runsOf()).runs.map((entry) => entry.runId), ["run-in-0002"]);
    assert.deepEqual((await runsOf("?principalId=worker-01")).runs.map((entry) => entry.runId), ["run-in-0002", "run-in-0001"]);
    assert.deepEqual((await runsOf("?principalId=worker-02")).runs, []);

    const viewer = await createTestHuman(database);
    await addTestWorkspaceMembership(database, workspace.id, viewer, "viewer");
    assert.equal((await requestAs(web, viewer)(`/api/workspaces/${workspace.id}/agent-runs`)).status, 200);
    const outsider = await createTestHuman(database);
    await addTestWorkspaceMembership(database, other.id, outsider, "owner");
    assert.equal((await requestAs(web, outsider)(`/api/workspaces/${workspace.id}/agent-runs`)).status, 404);
    assert.equal((await web.request(`/api/workspaces/${workspace.id}/agent-runs`)).status, 401);
    assert.equal((await requestAs(web, kit.owner)(`/api/workspaces/${workspace.id}/agent-runs?principalId=${"x".repeat(101)}`)).status, 400);
  } finally {
    await database.destroy();
  }
});
