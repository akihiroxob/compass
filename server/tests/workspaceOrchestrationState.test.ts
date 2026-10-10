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
 * 外部Orchestrator向けのWorkspace単位の現在状態Query（`get_workspace_orchestration_state`）。Serverが返す事実（ID・状態・件数だけ）・
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
  rationale: "Hidden rationale",
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
  const directory = mkdtempSync(join(tmpdir(), "compass-workspace-orchestration-"));
  return { path: join(directory, "compass.db"), remove: () => rmSync(directory, { recursive: true, force: true }) };
};

test("get_workspace_orchestration_stateはWorkspace・Outcome Target別のWork / 還流・評価可能性・ResearchをIDと件数だけで返し、未完了のarchived Targetを識別できる", async () => {
  const file = temporaryDatabase();
  try {
    let kit = await open(file.path);
    const { workspace, a, b, c, token, app } = await seedWorkspace(kit);
    const state = async (current: App = kit.app) => ok(await callTool(current, "get_workspace_orchestration_state", { workspaceId: workspace.id }, token));

    assert.deepEqual(await state(app), {
      workspace: { id: workspace.id, name: "Workspace", status: "active" },
      projects: [{ id: a.id, name: "A" }, { id: b.id, name: "B" }, { id: c.id, name: "C" }],
      activeIntent: null,
      outcomes: [],
      intentResearchRequests: [],
      openResearchRequests: [],
      observedAt: start,
    });

    // Intentと未終了のResearch。
    const intent = await kit.services.createIntentUseCase.execute(workspace.id, { title: "Hidden intent", desiredState: "Hidden desired state" });
    const request = await requestIntentResearch(kit.services, workspace.id, intent.id);
    const researching = await state();
    const requestFact = { id: request.id, kind: "decision", status: "requested", originIntentId: intent.id, originOutcomeId: null, updatedAt: request.updatedAt };
    assert.deepEqual(researching.activeIntent, { id: intent.id, status: "active", updatedAt: intent.updatedAt });
    assert.deepEqual(researching.openResearchRequests, [requestFact]);
    assert.deepEqual(researching.intentResearchRequests, [requestFact]);
    await kit.services.completeResearchRequestUseCase.execute(workspace.id, request.id, { conclusion: "not_needed", stopReason: "Known" });

    // Outcome 1: Target A / B、AだけStoryあり。Outcome 2: Targetなし。
    const shared = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
    const untargeted = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
    for (const project of [a, b]) {
      ok(await callTool(kit.app, "set_outcome_target", { workspaceId: workspace.id, outcomeId: shared.id, projectId: project.id }, "str"));
    }
    const taskA = await decompose(kit.app, a.id, shared.id);
    const planned = await state();
    assert.deepEqual(planned.openResearchRequests, []);
    assert.deepEqual(planned.outcomes.map((outcome: any) => outcome.id), [untargeted.id, shared.id], "Outcomeは新しい順");
    assert.deepEqual(planned.outcomes[0], {
      id: untargeted.id, status: "active", updatedAt: untargeted.updatedAt, targets: [],
      evaluability: { status: "no_targets", unfinishedTargets: [] }, latestEvaluation: null,
    });
    assert.deepEqual(planned.outcomes[1].targets, [
      { projectId: a.id, projectStatus: "active", work: { state: "incomplete", storyCount: 1, taskCount: 1 }, execution: null },
      { projectId: b.id, projectStatus: "active", work: null, execution: null },
    ]);
    assert.deepEqual(planned.outcomes[1].evaluability, {
      status: "awaiting_execution",
      unfinishedTargets: [
        { projectId: a.id, projectStatus: "active", reason: "not_reflected" },
        { projectId: b.id, projectStatus: "active", reason: "not_reflected" },
      ],
    });

    // Aを受け入れて還流し、Bは未着手のままarchiveする。Bはprojectsから外れ、Targetとしてだけarchivedで残る。
    await accept(kit.app, taskA);
    const reflectedA = await reflect(kit.app, a.id, shared.id);
    assert.equal(reflectedA.state, "accepted");
    await kit.services.archiveProjectUseCase.execute(b.id, { reason: "Dropped" });
    const replan = await state();
    assert.deepEqual(replan.projects, [{ id: a.id, name: "A" }, { id: c.id, name: "C" }]);
    assert.deepEqual(replan.outcomes[1].targets, [
      { projectId: a.id, projectStatus: "active", work: { state: "accepted", storyCount: 1, taskCount: 1 },
        execution: { state: "accepted", executionCursor: reflectedA.executionCursor } },
      { projectId: b.id, projectStatus: "archived", work: null, execution: null },
    ]);
    assert.deepEqual(replan.outcomes[1].evaluability, {
      status: "replan_required",
      unfinishedTargets: [{ projectId: b.id, projectStatus: "archived", reason: "not_reflected" }],
    });

    // 本文（Mission・Intent・Outcome・Story・Taskの文面）を含めない。
    const serialized = JSON.stringify(replan);
    for (const text of ["Secret mission", "Hidden"]) assert.equal(serialized.includes(text), false, `${text}を含めない`);

    // 読取は状態もActivityも変えず、同じ状態からは同じ応答になる。
    const activities = (await kit.database.selectFrom("activity").select("id").execute()).length;
    assert.deepEqual(await state(), replan);
    assert.equal((await kit.database.selectFrom("activity").select("id").execute()).length, activities);

    // 同じschemaで再起動しても同じ状態を読める。
    await kit.database.destroy();
    kit = await open(file.path);
    assert.deepEqual(await state(), replan);
    await kit.database.destroy();
  } finally {
    file.remove();
  }
});

test("get_workspace_orchestration_stateは最新EvaluationのProject別評価cursorと判断の有無を返し、archivedのWorkspaceは状態だけを返す", async () => {
  const kit = await open(":memory:");
  const { workspace, a, b, c, token } = await seedWorkspace(kit);
  const state = async () => ok(await callTool(kit.app, "get_workspace_orchestration_state", { workspaceId: workspace.id }, token));
  const intent = await kit.services.createIntentUseCase.execute(workspace.id, { title: "Intent", desiredState: "State" });
  const outcome = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
  ok(await callTool(kit.app, "set_outcome_target", { workspaceId: workspace.id, outcomeId: outcome.id, projectId: a.id }, "str"));
  await accept(kit.app, await decompose(kit.app, a.id, outcome.id));
  const reflected = await reflect(kit.app, a.id, outcome.id);
  assert.equal((await state()).outcomes[0].evaluability.status, "evaluable");

  const evaluation = ok(await callTool(kit.app, "record_outcome_evaluation", {
    workspaceId: workspace.id, outcomeId: outcome.id, requestKey: "evaluate-1", runRef: "run-evaluator",
    criteria: outcome.successCriteria.map((criterion) => ({ criterionId: criterion.id, verdict: "insufficient_evidence", rationale: "No evidence", evidenceIds: [] })),
  }, "ev")).evaluation;
  assert.deepEqual((await state()).outcomes[0].latestEvaluation, {
    id: evaluation.id, decisionId: null, createdAt: evaluation.createdAt,
    targets: [{ projectId: a.id, executionCursor: reflected.executionCursor }],
  });

  // 全Projectをarchiveしても所属Workspaceはactiveのまま。archivedのWorkspaceは状態だけを返す（OrchestratorはこのWorkspaceで起動しない）。
  for (const project of [a, b, c]) await kit.services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  assert.equal((await state()).workspace.status, "active");
  await new SQLiteWorkspaceRepository(asOrganizationDatabase(kit.database)).archive(workspace.id, "Done");
  assert.deepEqual(await state(), {
    workspace: { id: workspace.id, name: "Workspace", status: "archived" },
    projects: [],
    activeIntent: null,
    outcomes: [],
    intentResearchRequests: [],
    openResearchRequests: [],
    observedAt: start,
  });
  await kit.database.destroy();
});

test("get_workspace_orchestration_stateはWorkspace Runtime Credentialのruntime:state:readだけで認可し、Project Credential・Agent・別Workspaceから読めない", async () => {
  const kit = await open(":memory:");
  const { workspace, a, token } = await seedWorkspace(kit);
  const { workspace: other, token: otherToken } = await seedWorkspace(kit);
  const read = (bearer?: string, workspaceId = workspace.id) => callTool(kit.app, "get_workspace_orchestration_state", { workspaceId }, bearer);

  assert.equal(ok(await read(token)).workspace.id, workspace.id);
  assert.equal(errorCode(await read()), "UNAUTHENTICATED");
  // trusted-localのAgent名（Projectのruntime Grantを持つ）・Workspace Direction RoleのAgent名は使えない。
  assert.equal(errorCode(await read("rt")), "FORBIDDEN");
  assert.equal(errorCode(await read("str")), "FORBIDDEN");
  // 別Workspace・存在しないWorkspaceは区別せずFORBIDDEN。
  assert.equal(errorCode(await read(otherToken)), "FORBIDDEN");
  assert.equal(errorCode(await read(token, other.id)), "FORBIDDEN");
  assert.equal(errorCode(await read(token, "missing-workspace")), "FORBIDDEN");
  // scope不足のWorkspace Runtime Credential。
  const eventsOnly = await issueWorkspaceRuntimeToken(kit.database, kit.services, workspace.id, "events-only", ["runtime:event:read"]);
  assert.equal(errorCode(await read(eventsOnly)), "FORBIDDEN");
  // 所属ProjectのRuntime Credential（runtime:state:readを持つ）からは継承しない。
  const owner = await createTestHuman(kit.database);
  await addTestMembership(kit.database, a.id, owner, "owner");
  const projectRuntime = await kit.services.issueAccessCredentialUseCase.execute(
    { kind: "human", humanUserId: owner.humanUserId }, { kind: "project", id: a.id },
    { kind: "runtime", principalId: "orchestrator-a", scopes: ["runtime:state:read"] },
  );
  assert.equal(errorCode(await read(projectRuntime.token)), "FORBIDDEN");
  // Project Credentialは自身のProjectの入口だけで認可される（複数ProjectのWorkspaceではProject基準のStateがCONFLICTを返す）。
  assert.equal(errorCode(await callTool(kit.app, "get_orchestration_state", { projectId: a.id }, projectRuntime.token)), "CONFLICT");
  await kit.database.destroy();
});
