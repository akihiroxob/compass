import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { requestIntentResearch } from "./support/intentResearch.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

/**
 * 外部Orchestrator向けの現在状態Query（`get_orchestration_state`）。Orchestrator自体の起動判断は`orchestrator/tests`で検証する。
 * ここではServerが返す事実（状態とIDだけ）・認可・読取専用であることを確認する。
 */

const start = 1_800_000_000_000;

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => start);
  return { database, services, app: await createSignedInApp(database, services) };
};

const rpc = async (app: App, name: string, args: object, principal?: string, activeRole?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result as ToolResult;
};

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

const errorCode = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error.code as string;
};

const grant = async (app: App, projectId: string, principalId: string, role: string) =>
  assert.equal(
    (
      await app.request(`/api/projects/${projectId}/grants`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ principalId, role }),
      })
    ).status,
    201,
  );

const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [{ description: "duplicates = 0", measurement: "Count duplicates" }],
};

test("get_orchestration_stateは状態とIDだけを返し、Story・Taskの有無とResearchの未終了を区別する", async () => {
  const { database, services, app } = await setup();
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "Keep direction explicit" });
  await grant(app, project.id, "orchestrator", "runtime");
  await grant(app, project.id, "mgr", "manager");
  const state = async () => ok(await rpc(app, "get_orchestration_state", { projectId: project.id }, "orchestrator", "runtime"));

  assert.deepEqual(await state(), {
    project: { id: project.id, name: "Compass", status: "active" },
    openResearchRequests: [],
    observedAt: start,
    activeIntent: null,
    outcomes: [],
    intentResearchRequests: [],
  });

  // Intent作成直後: Research Requestは無い（Researchの要否はStrategistが判断する）。
  const intent = await services.createIntentUseCase.execute(project.id, { title: "Exclusive claims", desiredState: "One owner per Task" });
  const created = await state();
  assert.deepEqual(created.activeIntent, { id: intent.id, status: "active", updatedAt: intent.updatedAt });
  assert.deepEqual(created.outcomes, []);
  assert.deepEqual(created.intentResearchRequests, []);
  assert.equal(JSON.stringify(created).includes("One owner per Task"), false, "Intentの本文を含めない");

  // Researchを依頼すると、未終了のRequestとして現れる。終了すると未終了から外れ、Intentの履歴に残る。
  const request = await requestIntentResearch(services, project.id, intent.id);
  const requested = await state();
  const requestFact = {
    id: request.id,
    kind: "decision",
    status: "requested",
    originIntentId: intent.id,
    originOutcomeId: null,
    updatedAt: request.updatedAt,
  };
  assert.deepEqual(requested.openResearchRequests, [requestFact]);
  assert.deepEqual(requested.intentResearchRequests, [requestFact]);
  const closed = await services.completeResearchRequestUseCase.execute(project.id, request.id, {
    conclusion: "not_needed",
    stopReason: "Known",
  });
  const afterClose = await state();
  assert.deepEqual(afterClose.openResearchRequests, []);
  assert.deepEqual(afterClose.intentResearchRequests, [{ ...requestFact, status: "not_needed", updatedAt: closed.updatedAt }]);

  // Outcome確定直後はStoryが無い（未分解）。StoryとTaskを作るとWorkの件数に現れる。
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const confirmed = await state();
  assert.deepEqual(confirmed.outcomes, [
    { id: outcome.id, status: "active", updatedAt: outcome.updatedAt, work: null, execution: null, latestEvaluation: null },
  ]);
  const story = ok(
    await rpc(app, "issue_story", { projectId: project.id, title: "Claims", outcomeId: outcome.id, requestId: "story-1" }, "mgr"),
  );
  assert.deepEqual((await state()).outcomes[0].work, { state: "incomplete", storyCount: 1, taskCount: 0 });
  ok(await rpc(app, "issue_task", { projectId: project.id, storyId: story.id, title: "Guard", taskKey: "guard", requestId: "task-1" }, "mgr"));
  const decomposed = await state();
  assert.deepEqual(decomposed.outcomes[0].work, { state: "incomplete", storyCount: 1, taskCount: 1 });

  // 読取は状態を変えない。同じ状態からは同じ応答になる。
  assert.deepEqual(await state(), decomposed);
  await database.destroy();
});

test("get_orchestration_stateはruntime:state:readの認可を要求し、Agent RoleのGrantでは読めない", async () => {
  const { database, services, app } = await setup();
  const project = await services.createProjectUseCase.execute({ name: "Compass", mission: "m" });
  const other = await services.createProjectUseCase.execute({ name: "Other", mission: "m" });
  await grant(app, project.id, "orchestrator", "runtime");
  await grant(app, project.id, "strat", "strategist");

  assert.equal(errorCode(await rpc(app, "get_orchestration_state", { projectId: project.id })), "UNAUTHENTICATED");
  assert.equal(errorCode(await rpc(app, "get_orchestration_state", { projectId: project.id }, "strat")), "FORBIDDEN");
  assert.equal(errorCode(await rpc(app, "get_orchestration_state", { projectId: other.id }, "orchestrator")), "FORBIDDEN");
  // runtime以外のactiveRoleに固定した操作Contextからは読めない。
  assert.equal(errorCode(await rpc(app, "get_orchestration_state", { projectId: project.id }, "orchestrator", "manager")), "FORBIDDEN");
  ok(await rpc(app, "get_orchestration_state", { projectId: project.id }, "orchestrator"));
  ok(await rpc(app, "get_orchestration_state", { projectId: project.id }, "orchestrator", "runtime"));

  // archivedのProjectも読める（Orchestratorは起動しないと判断するためにstatusを読む）。
  await services.archiveProjectUseCase.execute(project.id, { reason: "Done" });
  assert.equal(ok(await rpc(app, "get_orchestration_state", { projectId: project.id }, "orchestrator")).project.status, "archived");
  await database.destroy();
});
