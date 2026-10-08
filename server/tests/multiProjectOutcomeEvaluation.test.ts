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
import { createSignedInApp, seedWorkspaceGrant } from "./support/humanSession.ts";

/**
 * 複数Target ProjectのOutcomeで、Work受入→Project別の還流→全Targetでの評価→Strategistの次判断までを、
 * 新規DB上のMCP / Web API呼出しで通す。Agentとして振る舞うのはtest内の呼出しだけで、Orchestratorによる
 * 複数Project Workspaceの起動（S08）は未接続。自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Kit = Awaited<ReturnType<typeof open>>;

const open = async (path: string) => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
};

const callTool = async (app: App, name: string, args: object, principal: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${principal}` },
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

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; message: string } & Record<string, any>;
};

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

/** 同じWorkspaceにProject A / Bを作り、各ProjectのExecution Role（Project Grant）とWorkspaceのEvaluator / Strategistを置く。 */
const seedWorkspace = async ({ database, services, app }: Kit) => {
  const organization = asOrganizationDatabase(database);
  const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(organization)).execute({ name: "Workspace", mission: "Mission" });
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(organization, projectRepositoryReferenceFinder));
  const a = (await createProject.execute(workspace.id, { name: "A" }))!;
  const b = (await createProject.execute(workspace.id, { name: "B" }))!;
  for (const project of [a, b]) {
    for (const [principalId, role] of [["mgr", "manager"], ["wrk", "worker"], ["rev", "reviewer"], ["rt", "runtime"]] as const) {
      const response = await app.request(`/api/projects/${project.id}/grants`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId, role }),
      });
      assert.equal(response.status, 201);
    }
  }
  await seedWorkspaceGrant(database, workspace.id, "ev", "evaluator");
  await seedWorkspaceGrant(database, workspace.id, "str", "strategist");
  const intent = await services.createIntentUseCase.execute(workspace.id, {
    title: "Shared release", desiredState: "Both Projects ship", completionDefinition: "Every Target Project ships the change",
  });
  return { workspace, a, b, intent };
};

const outcomeInput = () => ({
  title: next("Outcome"),
  description: "A and B ship the change",
  rationale: "Both Projects own a part",
  successCriteria: [
    { description: "A ships", measurement: "A's pull request is merged" },
    { description: "B ships", measurement: "B's pull request is merged" },
  ],
});

/** StrategistがTargetを設定したOutcomeに、各ProjectのManagerがStoryとTaskを1件ずつ作る。 */
const handOff = async (app: App, workspaceId: string, outcomeId: string, projectIds: string[]) => {
  const taskIds: string[] = [];
  for (const projectId of projectIds) {
    ok(await callTool(app, "set_outcome_target", { workspaceId, outcomeId, projectId }, "str"));
    const story = ok(await callTool(app, "issue_story", { projectId, title: next("Story"), outcomeId, requestId: next("story") }, "mgr"));
    const task = ok(await callTool(app, "issue_task", { projectId, storyId: story.id, title: next("Task"), taskKey: "deliver", requestId: next("task") }, "mgr"));
    taskIds.push(task.id);
  }
  return taskIds;
};

/** Taskをworkerが実装し、reviewerが確認し、managerが受け入れる（自己レビュー・自己受入は別Principal）。 */
const accept = async (app: App, taskId: string) => {
  const work = ok(await callTool(app, "claim_task", { taskId, requestId: next("claim") }, "wrk"));
  ok(await callTool(app, "add_task_comment", { taskId, claimId: work.claimId, body: "implemented", requestId: next("comment") }, "wrk"));
  ok(await callTool(app, "complete_task", { taskId, claimId: work.claimId, requestId: next("complete") }, "wrk"));
  const review = ok(await callTool(app, "claim_review", { taskId, requestId: next("review") }, "rev"));
  ok(await callTool(app, "reviewed_task", { taskId, claimId: review.claimId, requestId: next("reviewed") }, "rev"));
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId, requestId: next("accept-claim") }, "mgr"));
  ok(await callTool(app, "accept_task", { taskId, claimId: acceptance.claimId, requestId: next("accept") }, "mgr"));
};

/** RuntimeがProjectのChangeを最後まで読み、Execution SummaryとEvidence参照をOutcomeへ還流する。 */
const reflect = async (app: App, projectId: string, outcomeId: string, evidence: object[] = []) => {
  const changes = ok(await callTool(app, "list_changes", { projectId, afterCursor: 0 }, "mgr")) as { nextCursor: number };
  return ok(await callTool(app, "record_execution_evidence", { projectId, outcomeId, changeCursor: changes.nextCursor, evidence }, "rt"));
};

const pullRequest = (project: string) => ({
  kind: "pull_request", uri: `https://github.com/example/${project}/pull/${++counter}`, versionHash: "a".repeat(40), observedAt: Date.now() - 1_000,
});

type Judgment = { verdict: "met" | "not_met" | "insufficient_evidence"; evidenceIds: string[] };

const evaluate = (app: App, workspaceId: string, outcome: { id: string; successCriteria: readonly { id: string }[] }, judgments: Judgment[], requestKey: string) =>
  callTool(app, "record_outcome_evaluation", {
    workspaceId, outcomeId: outcome.id, requestKey, runRef: "run-evaluator",
    criteria: outcome.successCriteria.map((criterion, index) => ({
      criterionId: criterion.id, verdict: judgments[index]!.verdict, rationale: `observed ${judgments[index]!.verdict}`, evidenceIds: judgments[index]!.evidenceIds,
    })),
  }, "ev");

const evaluationRecords = async ({ database }: Kit) => [
  (await database.selectFrom("outcome_evaluation").selectAll().execute()).length,
  (await database.selectFrom("runtime_event").selectAll().where("event_type", "=", "outcome_evaluated").execute()).length,
  (await database.selectFrom("activity").selectAll().where("type", "=", "outcome.evaluated").execute()).length,
];

const temporaryDatabase = () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-multi-project-evaluation-"));
  return { path: join(directory, "compass.db"), remove: () => rmSync(directory, { recursive: true, force: true }) };
};

test("Accepting only Project A's Task never makes the Outcome achieved; missing Target B and the per-Project grounds stay traceable through Evaluation and the Strategist's next decision", async () => {
  const file = temporaryDatabase();
  try {
    let kit = await open(file.path);
    const { workspace, a, b, intent } = await seedWorkspace(kit);
    const outcome = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
    const [taskA, taskB] = await handOff(kit.app, workspace.id, outcome.id, [a.id, b.id]);

    // AのTaskだけを受け入れて還流。Bは未着手（todo）のまま還流する。
    await accept(kit.app, taskA!);
    const reflectedA = await reflect(kit.app, a.id, outcome.id, [pullRequest("a")]);
    assert.equal(reflectedA.summary.state, "accepted");
    const evidenceA = reflectedA.evidence[0].id as string;
    assert.equal((await reflect(kit.app, b.id, outcome.id)).summary.state, "incomplete");

    // Evaluator / Strategist / Human（Web API）のいずれからも、欠けているTargetがBであると分かる。
    const partial = { status: "awaiting_execution", unfinishedTargets: [{ projectId: b.id, projectStatus: "active", reason: "incomplete" }] };
    const evaluatorContext = ok(await callTool(kit.app, "get_evaluator_context", { workspaceId: workspace.id, outcomeId: outcome.id }, "ev"));
    assert.deepEqual(evaluatorContext.evaluability, partial);
    assert.deepEqual(evaluatorContext.targets.map((target: any) => [target.projectId, target.execution.summary.state]), [[a.id, "accepted"], [b.id, "incomplete"]]);
    assert.deepEqual(ok(await callTool(kit.app, "list_outcome_target_executions", { workspaceId: workspace.id, outcomeId: outcome.id }, "str")).evaluability, partial);
    const viaApi = await kit.app.request(`/api/workspaces/${workspace.id}/outcomes/${outcome.id}/target-executions`);
    assert.equal(viaApi.status, 200);
    assert.deepEqual((await viaApi.json()).evaluability, partial);

    // Aの受入だけでは評価を保存せず、Outcomeは達成にならない。Strategistへ渡る評価も無い。
    const rejected = errorOf(await evaluate(kit.app, workspace.id, outcome, [{ verdict: "met", evidenceIds: [evidenceA] }, { verdict: "met", evidenceIds: [evidenceA] }], "only-a"));
    assert.deepEqual([rejected.code, rejected.reason, rejected.unfinishedProjectIds], ["CONFLICT", "awaiting_execution", b.id]);
    assert.deepEqual(await evaluationRecords(kit), [0, 0, 0]);
    assert.equal((await kit.services.getOutcomeUseCase.execute(workspace.id, intent.id, outcome.id)).status, "active");
    assert.deepEqual(ok(await callTool(kit.app, "get_strategist_context", { workspaceId: workspace.id }, "str")).evaluations, []);

    // BもTaskを受け入れたがEvidence参照を還流していない。Evaluatorは推測せず、Bの成功条件をinsufficient_evidenceにする。
    await accept(kit.app, taskB!);
    assert.equal((await reflect(kit.app, b.id, outcome.id)).summary.state, "accepted");
    const ready = ok(await callTool(kit.app, "get_evaluator_context", { workspaceId: workspace.id, outcomeId: outcome.id }, "ev"));
    assert.deepEqual(ready.evaluability, { status: "evaluable", unfinishedTargets: [] });
    const insufficientArgs: Judgment[] = [{ verdict: "met", evidenceIds: [evidenceA] }, { verdict: "insufficient_evidence", evidenceIds: [] }];
    const insufficient = ok(await evaluate(kit.app, workspace.id, outcome, insufficientArgs, "insufficient")).evaluation;
    assert.equal(insufficient.result, "insufficient_evidence");
    // 根拠（Aの還流Evidence）と、Evidenceの無いTarget（B）がProject別のsnapshotから辿れる。
    assert.deepEqual(insufficient.snapshot.targets.map((target: any) => [target.projectId, target.execution.state, target.evidence.map((item: any) => item.id)]), [
      [a.id, "accepted", [evidenceA]],
      [b.id, "accepted", []],
    ]);
    assert.deepEqual(insufficient.criteria.map((criterion: any) => [criterion.verdict, criterion.evidenceIds]), [["met", [evidenceA]], ["insufficient_evidence", []]]);
    assert.equal((await kit.services.getOutcomeUseCase.execute(workspace.id, intent.id, outcome.id)).status, "active");

    // 評価は1件のoutcome_evaluated（evaluationId付き）でStrategistの起動へつながり、再送では増えない。
    const replayed = ok(await evaluate(kit.app, workspace.id, outcome, insufficientArgs, "insufficient"));
    assert.deepEqual([replayed.recorded, replayed.evaluation.id], [false, insufficient.id]);
    assert.deepEqual(await evaluationRecords(kit), [1, 1, 1]);
    const evaluated = (await kit.services.workspaceDirection.listRuntimeEventsUseCase.execute(workspace.id, { limit: 100 }))
      .filter((event) => event.type === "outcome_evaluated");
    assert.deepEqual(evaluated.map((event) => [event.outcomeId, event.evaluationId]), [[outcome.id, insufficient.id]]);

    // StrategistはContextでProject別の根拠を読み、そのEvaluationを根拠に追加Researchを判断する。
    const strategist = ok(await callTool(kit.app, "get_strategist_context", { workspaceId: workspace.id }, "str"));
    assert.deepEqual(strategist.evaluations.map((item: any) => [item.id, item.result, item.decisionId]), [[insufficient.id, "insufficient_evidence", null]]);
    assert.deepEqual(strategist.evaluations[0].snapshot.targets.map((target: any) => [target.projectId, target.evidence.length]), [[a.id, 1], [b.id, 0]]);
    const researchArgs = {
      workspaceId: workspace.id, intentId: intent.id, type: "additional_research", evaluationId: insufficient.id,
      judgment: "B's shipment is not observable", reason: "Target B reflected no Evidence", requestKey: "research-b", runRef: "run-strategist",
      research: { question: "Did B ship?", scope: "Project B", completionCondition: "B's pull request is found", budgetTotal: 10 },
    };
    const research = ok(await callTool(kit.app, "create_direction_decision", researchArgs, "str"));
    assert.equal(research.decision.evaluationId, insufficient.id);
    await kit.database.destroy();

    // 同じschemaで再起動: 評価・判断が残り、同じrequestKeyの再送は保存済みの結果を返して増やさない。
    kit = await open(file.path);
    assert.deepEqual(await evaluationRecords(kit), [1, 1, 1]);
    assert.equal(ok(await evaluate(kit.app, workspace.id, outcome, insufficientArgs, "insufficient")).evaluation.id, insufficient.id);
    assert.equal(ok(await callTool(kit.app, "create_direction_decision", researchArgs, "str")).decision.id, research.decision.id);
    assert.equal(ok(await callTool(kit.app, "get_strategist_context", { workspaceId: workspace.id }, "str")).evaluations[0].decisionId, research.decision.id);

    // Bが根拠を還流した後の再評価で、両Targetの根拠からachievedになり、それを根拠にIntent完了を判断できる。
    const evidenceB = (await reflect(kit.app, b.id, outcome.id, [pullRequest("b")])).evidence[0].id as string;
    const achieved = ok(await evaluate(kit.app, workspace.id, outcome, [{ verdict: "met", evidenceIds: [evidenceA] }, { verdict: "met", evidenceIds: [evidenceB] }], "achieved")).evaluation;
    assert.equal(achieved.result, "achieved");
    assert.deepEqual(achieved.snapshot.targets.map((target: any) => [target.projectId, target.evidence.map((item: any) => item.id)]), [[a.id, [evidenceA]], [b.id, [evidenceB]]]);
    const history = await kit.app.request(`/api/workspaces/${workspace.id}/outcomes/${outcome.id}/evaluations`);
    assert.equal(history.status, 200);
    assert.deepEqual((await history.json()).evaluations.map((item: any) => [item.id, item.result]), [[achieved.id, "achieved"], [insufficient.id, "insufficient_evidence"]]);
    const latest = ok(await callTool(kit.app, "get_strategist_context", { workspaceId: workspace.id }, "str")).evaluations;
    assert.deepEqual(latest.map((item: any) => [item.id, item.decisionId]), [[achieved.id, null]]);
    const complete = ok(await callTool(kit.app, "create_direction_decision", {
      workspaceId: workspace.id, intentId: intent.id, type: "intent_complete", evaluationId: achieved.id,
      judgment: "Both Projects shipped", reason: "Every Target Project's Evidence meets its criterion", requestKey: "complete", runRef: "run-strategist",
    }, "str"));
    assert.equal(complete.decision.evaluationId, achieved.id);
    assert.equal((await kit.services.getIntentUseCase.execute(workspace.id, intent.id)).status, "achieved");
    await kit.database.destroy();
  } finally {
    file.remove();
  }
});

test("A failed criterion of one Target makes the multi-Project Outcome failed and leads to the next Outcome; a single-Target Outcome stays evaluable from that Project alone", async () => {
  const file = temporaryDatabase();
  try {
    const kit = await open(file.path);
    const { workspace, a, b, intent } = await seedWorkspace(kit);

    // 単一TargetのOutcome: 同じWorkspaceに他のProjectがあっても、Target Aだけの完了で評価できる。
    const single = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
    const [singleTask] = await handOff(kit.app, workspace.id, single.id, [a.id]);
    await accept(kit.app, singleTask!);
    const singleEvidence = (await reflect(kit.app, a.id, single.id, [pullRequest("a")])).evidence[0].id as string;
    const singleEvaluation = ok(await evaluate(kit.app, workspace.id, single, [{ verdict: "met", evidenceIds: [singleEvidence] }, { verdict: "met", evidenceIds: [singleEvidence] }], "single")).evaluation;
    assert.deepEqual([singleEvaluation.result, singleEvaluation.snapshot.targets.map((target: any) => target.projectId)], ["achieved", [a.id]]);

    // 複数TargetのOutcome: AはmetでもBのnot_metでfailed。Strategistはそれを根拠に次のOutcomeを1件だけ判断する。
    const shared = await kit.services.createOutcomeUseCase.execute(workspace.id, intent.id, outcomeInput());
    const [taskA, taskB] = await handOff(kit.app, workspace.id, shared.id, [a.id, b.id]);
    await accept(kit.app, taskA!);
    await accept(kit.app, taskB!);
    const evidenceA = (await reflect(kit.app, a.id, shared.id, [pullRequest("a")])).evidence[0].id as string;
    const evidenceB = (await reflect(kit.app, b.id, shared.id, [pullRequest("b")])).evidence[0].id as string;
    const failed = ok(await evaluate(kit.app, workspace.id, shared, [{ verdict: "met", evidenceIds: [evidenceA] }, { verdict: "not_met", evidenceIds: [evidenceB] }], "failed")).evaluation;
    assert.equal(failed.result, "failed");

    const context = ok(await callTool(kit.app, "get_strategist_context", { workspaceId: workspace.id }, "str"));
    assert.deepEqual(
      context.evaluations.map((item: any) => [item.outcomeId, item.result, item.decisionId]).sort(),
      [[shared.id, "failed", null], [single.id, "achieved", null]].sort(),
    );
    const nextArgs = {
      workspaceId: workspace.id, intentId: intent.id, evaluationId: failed.id, judgment: "B needs another attempt",
      reason: "B's criterion is not met", requestKey: "next-b", runRef: "run-strategist", outcome: outcomeInput(),
    };
    const decided = ok(await callTool(kit.app, "decide_next_outcome", nextArgs, "str"));
    assert.equal(decided.decision.evaluationId, failed.id);
    assert.equal(ok(await callTool(kit.app, "decide_next_outcome", nextArgs, "str")).outcome.id, decided.outcome.id);
    const duplicate = errorOf(await callTool(kit.app, "decide_next_outcome", { ...nextArgs, requestKey: "next-b-again", outcome: outcomeInput() }, "str"));
    assert.equal(duplicate.code, "CONFLICT");
    // 次のOutcomeはTarget未設定から始まり、評価できない。Target判断はStrategistへ戻る。
    assert.deepEqual(ok(await callTool(kit.app, "list_outcome_target_executions", { workspaceId: workspace.id, outcomeId: decided.outcome.id }, "str")).evaluability,
      { status: "no_targets", unfinishedTargets: [] });
    assert.equal((await kit.services.getIntentUseCase.execute(workspace.id, intent.id)).status, "active");

    // 複数ProjectのWorkspaceは、Project基準のOrchestration Stateでは扱わない（S08で切替）。
    const state = errorOf(await callTool(kit.app, "get_orchestration_state", { projectId: a.id }, "rt"));
    assert.deepEqual([state.code, state.reason], ["CONFLICT", "workspace_direction_required"]);
    await kit.database.destroy();
  } finally {
    file.remove();
  }
});
