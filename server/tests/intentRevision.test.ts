import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateWorkspaceProjectUseCase, CreateWorkspaceUseCase, SQLiteProjectRepository, SQLiteWorkspaceRepository } from "@compass/organization";
import type { createApp } from "../src/bootstrap/app.ts";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";
import { addTestMembership, createSignedInApp, createTestHuman, issueWorkspaceRuntimeToken, seedWorkspaceGrant } from "./support/humanSession.ts";
import { requestIntentResearch } from "./support/intentResearch.ts";

/**
 * (helpers copied) 外部Orchestrator向けのWorkspace単位の現在状態Query（`get_workspace_orchestration_state`）。Serverが返す事実（ID・状態・件数だけ）・
 * Workspace Runtime Credentialでの認可・読取専用であることを新規DBで確認する。Orchestratorのdispatch規則への接続（S08-02）は対象外。
 */

const start = 1_800_000_000_000;

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Kit = Awaited<ReturnType<typeof open>>;

const open = async (path: string) => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => start);
  return { database, services, app: await createSignedInApp(database, services) };
};

const callTool = async (app: App, name: string, args: object, bearer?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(bearer === undefined ? {} : { Authorization: `Bearer ${bearer}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error.code as string;
};

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

/** 同じWorkspaceにProject A / B / Cを作り、各ProjectのExecution Role（Project Grant）とWorkspaceのStrategist / Evaluatorを置く。 */
const seedWorkspace = async ({ database, services, app }: Kit) => {
  const organization = asOrganizationDatabase(database);
  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(organization)).execute({ name: "Workspace", mission: "Secret mission" });
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(organization, projectRepositoryReferenceFinder));
  const projects = [];
  for (const name of ["A", "B", "C"]) {
    const project = (await createProject.execute(workspace.id, { name }))!;
    for (const [principalId, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"], ["rt", "runtime"]] as const) {
      await services.grantProjectRoleUseCase.execute(project.id, { principalId, role });
    }
    projects.push(project);
  }
  await seedWorkspaceGrant(database, workspace.id, "str", "strategist");
  await seedWorkspaceGrant(database, workspace.id, "ev", "evaluator");
  const token = await issueWorkspaceRuntimeToken(database, services, workspace.id, "orchestrator", ["runtime:state:read"]);
  return { workspace, a: projects[0]!, b: projects[1]!, c: projects[2]!, token, app };
};

const outcomeInput = () => ({
  title: next("Hidden outcome title"),
  description: "Hidden outcome description",
  intentVersion: 1, rationale: "Hidden rationale",
  successCriteria: [{ description: "Hidden criterion", measurement: "Hidden measurement" }],
});

/** ManagerがProjectにOutcomeのStoryとTaskを1件ずつ作る。 */
const decompose = async (app: App, projectId: string, outcomeId: string) => {
  const story = ok(await callTool(app, "issue_story", { projectId, title: "Hidden story", outcomeId, requestId: next("story") }, "mgr"));
  return ok(await callTool(app, "issue_task", { projectId, storyId: story.id, title: "Hidden task", taskKey: "deliver", requestId: next("task") }, "mgr")).id as string;
};

/** Taskをworkerが実装し、reviewerが確認し、managerが受け入れる。 */
const accept = async (app: App, taskId: string) => {
  const work = ok(await callTool(app, "claim_task", { taskId, requestId: next("claim") }, "wrk"));
  ok(await callTool(app, "add_task_comment", { taskId, claimId: work.claimId, body: "implemented", requestId: next("comment") }, "wrk"));
  ok(await callTool(app, "complete_task", { taskId, claimId: work.claimId, requestId: next("complete") }, "wrk"));
  const review = ok(await callTool(app, "claim_review", { taskId, requestId: next("review") }, "rev"));
  ok(await callTool(app, "reviewed_task", { taskId, claimId: review.claimId, requestId: next("reviewed") }, "rev"));
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId, requestId: next("accept-claim") }, "mgr"));
  ok(await callTool(app, "accept_task", { taskId, claimId: acceptance.claimId, requestId: next("accept") }, "mgr"));
};

/** RuntimeがProjectのChangeを最後まで読み、Execution SummaryをOutcomeへ還流する。 */
const reflect = async (app: App, projectId: string, outcomeId: string) => {
  const changes = ok(await callTool(app, "list_changes", { projectId, afterCursor: 0 }, "mgr")) as { nextCursor: number };
  return ok(await callTool(app, "record_execution_evidence", { projectId, outcomeId, changeCursor: changes.nextCursor }, "rt")).summary as {
    state: string;
    executionCursor: number;
  };
};

const temporaryDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-intent-revision-"));
  return { path: join(directory, "compass.db"), remove: () => rmSync(directory, { recursive: true, force: true }) };
};

const web = (app: App, method: string, path: string, body?: object) =>
  app.request(path, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });

test("目標の見直しは版・変更主体・理由を残し、Outcome・判断・評価は元の版を参照し、競合と再計画対象と終端操作を正しく扱う", async () => {
  const file = temporaryDatabase();
  try {
    const kit = await open(file.path);
    const { workspace, a, token, app } = await seedWorkspace(kit);
    const state = async () => ok(await callTool(app, "get_workspace_orchestration_state", { workspaceId: workspace.id }, token));
    const intentUrl = (id: string) => `/api/workspaces/${workspace.id}/intents/${id}`;

    // Given: StrategistがMCPで目標とOutcomeを登録し、Target Projectの未完了作業を用意する。
    const intent = ok(await callTool(app, "create_intent", { workspaceId: workspace.id, title: "売上", desiredState: "月30万円", completionDefinition: "売上データで確認" }, "str"));
    assert.deepEqual([intent.version, intent.meaningVersion], [1, 1]);
    const outcome = ok(await callTool(app, "create_outcome", { workspaceId: workspace.id, intentId: intent.id, ...outcomeInput() }, "str")).outcome;
    assert.equal(outcome.intentVersion, 1);
    ok(await callTool(app, "set_outcome_target", { workspaceId: workspace.id, outcomeId: outcome.id, projectId: a.id }, "str"));
    const taskId = await decompose(app, a.id, outcome.id);
    const taskStatus = async () => ok(await callTool(app, "list_tasks", { projectId: a.id }, "mgr")).tasks.find((task: any) => task.id === taskId).status as string;
    assert.equal(await taskStatus(), "todo");

    // 2つの画面（Human Web / Agent MCP）が同じ版1から編集する。先に保存した側が勝ち、後の側は競合で何も変えない。
    const first = await web(app, "PATCH", intentUrl(intent.id), { expectedVersion: 1, desiredState: "月50万円", reason: "市場調査で目標を引き上げた" });
    assert.equal(first.status, 200);
    const stale = await callTool(app, "update_intent", { workspaceId: workspace.id, intentId: intent.id, expectedVersion: 1, title: "古い画面からの更新" }, "str");
    assert.equal(errorCode(stale), "CONFLICT");
    assert.deepEqual([stale.structuredContent.error.conflict, stale.structuredContent.error.currentVersion], ["intent_version", "2"]);
    assert.equal(ok(await callTool(app, "get_intent", { workspaceId: workspace.id, intentId: intent.id }, "str")).title, "売上", "古い編集は保存されない");
    // 理由のない意味変更は、全面禁止ではなく理由を求めるだけ。
    assert.equal(errorCode(await callTool(app, "update_intent", { workspaceId: workspace.id, intentId: intent.id, expectedVersion: 2, completionDefinition: "別の確認方法" }, "str")), "VALIDATION_ERROR");
    const second = ok(await callTool(app, "update_intent", { workspaceId: workspace.id, intentId: intent.id, expectedVersion: 2, title: "売上の目標" }, "str"));
    assert.deepEqual([second.version, second.meaningVersion], [3, 2]);

    // 版・変更主体・理由が履歴に残り、元の版の内容は書き換わらない。
    const revisions = ok(await callTool(app, "list_intent_revisions", { workspaceId: workspace.id, intentId: intent.id }, "str")).revisions;
    assert.deepEqual(revisions.map((revision: any) => revision.version), [3, 2, 1]);
    assert.deepEqual(revisions.map((revision: any) => revision.desiredState), ["月50万円", "月50万円", "月30万円"]);
    assert.equal(revisions[1].reason, "市場調査で目標を引き上げた");
    assert.equal(revisions[1].meaningChanged, true);
    assert.ok(String(revisions[1].changedBy).startsWith("human:"), "Humanの操作はHumanとして記録する");
    assert.equal(revisions[1].changedByRole, "operator");
    assert.deepEqual([revisions[0].changedBy, revisions[0].changedByRole], ["str", "strategist"], "Agentの操作をHumanとして記録しない");
    assert.equal(revisions[2].changedBy, "str");

    // Outcomeは作成時の版を保持し、影響する未完了のOutcomeは再計画対象として識別される。作業は止めず、状態も変えない。
    assert.equal(ok(await callTool(app, "list_outcomes", { workspaceId: workspace.id, intentId: intent.id }, "str")).outcomes[0].intentVersion, 1);
    const revised = await state();
    assert.deepEqual(revised.activeIntents.map(({ id, version, meaningVersion }: any) => [id, version, meaningVersion]), [[intent.id, 3, 2]]);
    assert.deepEqual([revised.outcomes[0].status, revised.outcomes[0].intentVersion, revised.outcomes[0].intentRevised], ["active", 1, { outcomeIntentVersion: 1, meaningVersion: 2 }]);
    assert.equal(await taskStatus(), "todo");

    // 古い版の判断は競合にし、現在版の判断として扱わない。現在版なら判断は版を保持する。
    const decision = { workspaceId: workspace.id, intentId: intent.id, type: "policy_proposal", intentVersion: 1, judgment: "方針案", reason: "理由", requestKey: next("decision"), runRef: "run-1" };
    assert.equal(errorCode(await callTool(app, "create_direction_decision", { ...decision, intentVersion: 1 }, "str")), "CONFLICT");
    const decided = ok(await callTool(app, "create_direction_decision", { ...decision, intentVersion: 3 }, "str"));
    assert.equal(decided.decision.intentVersion, 3);
    // 版を省略した判断・Outcome作成は、現在版への暗黙の付け替えをせず拒否する（省略・古い版・現在版を区別する）。
    const withoutVersion = <T extends { intentVersion: number }>({ intentVersion: _omitted, ...rest }: T) => rest;
    const omittedDecision = await callTool(app, "create_direction_decision", withoutVersion({ ...decision, requestKey: next("decision-omitted") }), "str");
    assert.equal(omittedDecision.isError, true);
    assert.match(JSON.stringify(omittedDecision), /intentVersion/);
    const omittedOutcome = await callTool(app, "create_outcome", withoutVersion({ workspaceId: workspace.id, intentId: intent.id, ...outcomeInput() }), "str");
    assert.equal(omittedOutcome.isError, true);
    assert.match(JSON.stringify(omittedOutcome), /intentVersion/);
    const omittedNext = await callTool(app, "decide_next_outcome", withoutVersion({ ...decision, requestKey: next("next-omitted"), outcome: outcomeInput() }), "str");
    assert.equal(omittedNext.isError, true);
    assert.equal(ok(await callTool(app, "list_outcomes", { workspaceId: workspace.id, intentId: intent.id }, "str")).outcomes.length, 1, "省略した作成は何も保存しない");
    assert.equal(errorCode(await callTool(app, "create_outcome", { workspaceId: workspace.id, intentId: intent.id, ...outcomeInput(), intentVersion: 1 }, "str")), "CONFLICT");

    // Strategistが現在版を確認すると再計画対象から外れる。古い版での確認は競合。
    assert.equal(errorCode(await callTool(app, "update_outcome", { workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id, intentVersion: 1 }, "str")), "CONFLICT");
    ok(await callTool(app, "update_outcome", { workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id, intentVersion: 3 }, "str"));
    assert.equal((await state()).outcomes[0].intentRevised, null);

    // 終端操作: 古い版の放棄は競合。放棄はOutcomeを取消にし（達成にしない）、Taskは変えず、Orchestratorは現在状態を返す。
    assert.equal((await web(app, "POST", `${intentUrl(intent.id)}/abandon`, { expectedVersion: 2, reason: "x" })).status, 409);
    assert.equal(ok(await callTool(app, "get_intent", { workspaceId: workspace.id, intentId: intent.id }, "str")).status, "active");
    assert.equal((await web(app, "POST", `${intentUrl(intent.id)}/abandon`, { expectedVersion: 3, reason: "方針転換" })).status, 200);
    const after = ok(await callTool(app, "get_outcome", { workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id }, "str")).outcome;
    assert.deepEqual([after.status, after.cancelReason], ["cancelled", "Intent abandoned: 方針転換"]);
    assert.equal(await taskStatus(), "todo", "Taskを無断で完了にしない");
    const ended = await state();
    assert.deepEqual([ended.activeIntents, ended.outcomes], [[], []]);
    const listed = (await (await web(app, "GET", `/api/workspaces/${workspace.id}/intents`)).json()) as { intents: { id: string; status: string }[] };
    assert.deepEqual(listed.intents.map(({ status }) => status), ["abandoned"]);
    // 終端した目標は編集できない（版が合っていても競合ではなく状態の競合）。
    assert.equal((await web(app, "PATCH", intentUrl(intent.id), { expectedVersion: 3, title: "終端後" })).status, 409);
  } finally {
    file.remove();
  }
});
