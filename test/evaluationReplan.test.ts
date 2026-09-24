import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * Evaluationから再計画・Intent完了への遷移（Task 36）。Runtime・Evaluator・Strategistとして振る舞うのはtest内の
 * MCP呼び出しだけで、外部Runtimeによる起動は未接続。Lv6の自律運転の実証ではない。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Kit = Awaited<ReturnType<typeof setup>>;

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: await createSignedInApp(database, services) };
};

const rpc = async (app: App, method: string, params: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> =>
  (await rpc(app, "tools/call", { name, arguments: args }, principal)).result;

const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; message: string } & Record<string, any>;
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

const grants: readonly (readonly [string, string])[] = [
  ["mgr", "manager"],
  ["wrk", "worker"],
  ["rev", "reviewer"],
  ["rt", "runtime"],
  ["ev", "evaluator"],
  ["str", "strategist"],
];

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

const seedProject = async ({ services, app }: Kit, completionDefinition: string | null = "Every Task has exactly one owner") => {
  const project = await services.createProjectUseCase.execute({ name: next("Compass"), mission: "Keep execution guarded" });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: "Guarded claims",
    desiredState: "One owner per Task",
    completionDefinition,
  });
  for (const [principal, role] of grants) await grant(app, project.id, principal, role);
  return { project, intent };
};

const outcomeInput = () => ({
  title: next("Outcome"),
  description: "Claims are exclusive.",
  rationale: "Rework",
  successCriteria: [
    { description: "criterion 1", measurement: "Measure 1", target: "= 0" },
    { description: "criterion 2", measurement: "Measure 2" },
  ],
});

/** Outcomeを参照するStoryのTaskを1件acceptedまで進め、Evidence参照付きで還流する。 */
const executeAndReflect = async ({ app }: Kit, projectId: string, outcomeId: string) => {
  const story = ok(await callTool(app, "issue_story", { projectId, title: next("Story"), outcomeId, requestId: next("story") }, "mgr"));
  const task = ok(await callTool(app, "issue_task", { projectId, storyId: story.id, title: next("Task"), taskKey: next("key"), requestId: next("task") }, "mgr"));
  const work = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: next("claim") }, "wrk"));
  ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "done", requestId: next("comment") }, "wrk"));
  ok(await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: next("complete") }, "wrk"));
  const review = ok(await callTool(app, "claim_review", { taskId: task.id, requestId: next("review") }, "rev"));
  ok(await callTool(app, "reviewed_task", { taskId: task.id, claimId: review.claimId, requestId: next("reviewed") }, "rev"));
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId: task.id, requestId: next("accept-claim") }, "mgr"));
  ok(await callTool(app, "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: next("accept") }, "mgr"));
  const changes = ok(await callTool(app, "list_changes", { projectId, afterCursor: 0 }, "rt")) as { nextCursor: number };
  const reflected = ok(
    await callTool(
      app,
      "record_execution_evidence",
      {
        projectId,
        outcomeId,
        changeCursor: changes.nextCursor,
        evidence: [{ kind: "pull_request", uri: `https://github.com/example/compass/pull/${++counter}`, versionHash: "a".repeat(40), observedAt: Date.now() - 1_000 }],
      },
      "rt",
    ),
  );
  return reflected.evidence.map((item: Record<string, any>) => item.id as string);
};

type Verdict = "met" | "not_met" | "insufficient_evidence";

const evaluate = async (kit: Kit, projectId: string, outcome: { id: string; successCriteria: readonly { id: string }[] }, verdicts: Verdict[], evidenceIds: string[], requestKey = next("eval")) =>
  callTool(
    kit.app,
    "record_outcome_evaluation",
    {
      projectId,
      outcomeId: outcome.id,
      requestKey,
      runRef: "run-evaluator",
      criteria: outcome.successCriteria.map((criterion, index) => ({
        criterionId: criterion.id,
        verdict: verdicts[index]!,
        rationale: `observed ${verdicts[index]}`,
        evidenceIds: verdicts[index] === "insufficient_evidence" ? [] : evidenceIds.slice(0, 1),
      })),
    },
    "ev",
  );

/** Active Outcome・還流済みExecution・指定結果のEvaluationがある状態。 */
const seedEvaluated = async (kit: Kit, verdicts: Verdict[], completionDefinition?: string | null) => {
  const { project, intent } = await seedProject(kit, completionDefinition);
  const outcome = await kit.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput());
  const evidenceIds = await executeAndReflect(kit, project.id, outcome.id);
  const evaluation = ok(await evaluate(kit, project.id, outcome, verdicts, evidenceIds)).evaluation;
  return { project, intent, outcome, evidenceIds, evaluation };
};

const decisionArgs = (projectId: string, intentId: string, overrides: Record<string, unknown> = {}) => ({
  projectId,
  intentId,
  judgment: "Decide from the Evaluation",
  reason: "The Evaluation shows the observed result",
  requestKey: next("decision"),
  runRef: "run-strategist",
  ...overrides,
});

const events = async (kit: Kit, projectId: string) =>
  kit.services.listRuntimeEventsUseCase.execute(projectId, { limit: 500 });

const intentStatus = async (kit: Kit, projectId: string, intentId: string) =>
  (await kit.services.getIntentUseCase.execute(projectId, intentId)).status;

test("Evaluationの確定はoutcome_evaluatedを1件だけ作り、Runtimeが相関ID・evaluationId付きで取得できる（再送では増えない）", async () => {
  const kit = await setup();
  const { project, intent, outcome, evidenceIds, evaluation } = await seedEvaluated(kit, ["not_met", "met"]);
  assert.equal(evaluation.result, "failed");

  // 同じrequestKeyの再送（応答消失）では、Evaluationもイベントも増えない。
  const replay = ok(await evaluate(kit, project.id, outcome, ["not_met", "met"], evidenceIds, evaluation.requestKey));
  assert.equal(replay.recorded, false);

  const evaluated = (await events(kit, project.id)).filter((event) => event.type === "outcome_evaluated");
  assert.equal(evaluated.length, 1);
  assert.equal(evaluated[0]!.evaluationId, evaluation.id);
  assert.equal(evaluated[0]!.outcomeId, outcome.id);
  assert.equal(evaluated[0]!.intentId, intent.id);
  assert.equal(evaluated[0]!.correlationId, `outcome:${outcome.id}`);

  const fetched = ok(await callTool(kit.app, "fetch_runtime_events", { projectId: project.id }, "rt"));
  const event = fetched.events.find((item: Record<string, any>) => item.type === "outcome_evaluated");
  assert.equal(event.evaluationId, evaluation.id);

  // 再評価は新しいEvaluationごとに1件ずつ。
  const second = ok(await evaluate(kit, project.id, outcome, ["met", "met"], evidenceIds)).evaluation;
  const after = (await events(kit, project.id)).filter((item) => item.type === "outcome_evaluated");
  assert.deepEqual(after.map((item) => item.evaluationId), [evaluation.id, second.id]);
  await kit.database.destroy();
});

test("failedのEvaluationからStrategistがContextを読み、次のOutcomeを1件だけ判断できる（重複起動・再送でも増えない）", async () => {
  const kit = await setup();
  const { project, intent, outcome, evaluation } = await seedEvaluated(kit, ["not_met", "met"]);

  const context = ok(await callTool(kit.app, "get_strategist_context", { projectId: project.id }, "str"));
  assert.deepEqual(context.evaluations.map((item: Record<string, any>) => [item.id, item.outcomeId, item.result, item.decisionId]), [
    [evaluation.id, outcome.id, "failed", null],
  ]);
  assert.equal(context.evaluations[0].criteria[0].verdict, "not_met");

  const args = decisionArgs(project.id, intent.id, { evaluationId: evaluation.id, outcome: outcomeInput() });
  const decided = ok(await callTool(kit.app, "decide_next_outcome", args, "str"));
  assert.equal(decided.decision.evaluationId, evaluation.id);
  assert.equal(decided.decision.type, "next_outcome");
  assert.equal(decided.outcome.originDecisionId, decided.decision.id);

  // 同じrequestKeyの再送は同じ判断・同じOutcomeを返す。
  const replay = ok(await callTool(kit.app, "decide_next_outcome", args, "str"));
  assert.equal(replay.outcome.id, decided.outcome.id);

  // 同じEvaluationでStrategistが重複起動しても、2件目の再計画は作れない。
  const duplicate = errorOf(
    await callTool(kit.app, "decide_next_outcome", decisionArgs(project.id, intent.id, { evaluationId: evaluation.id, outcome: outcomeInput() }), "str"),
  );
  assert.equal(duplicate.code, "CONFLICT");
  assert.match(duplicate.message, /already used/);
  const research = errorOf(
    await callTool(
      kit.app,
      "create_direction_decision",
      decisionArgs(project.id, intent.id, {
        type: "additional_research",
        evaluationId: evaluation.id,
        research: { question: "Why?", scope: "claims", completionCondition: "cause found", budgetTotal: 10 },
      }),
      "str",
    ),
  );
  assert.equal(research.code, "CONFLICT");

  const outcomes = await kit.services.listOutcomesUseCase.execute(project.id, intent.id);
  assert.equal(outcomes.length, 2);
  const confirmed = (await events(kit, project.id)).filter((item) => item.type === "outcome_confirmed");
  assert.deepEqual(confirmed.map((item) => item.outcomeId).sort(), [outcome.id, decided.outcome.id].sort());

  const after = ok(await callTool(kit.app, "get_strategist_context", { projectId: project.id }, "str"));
  assert.equal(after.evaluations.find((item: Record<string, any>) => item.id === evaluation.id).decisionId, decided.decision.id);
  // 再計画はIntentを完了させず、元のOutcomeも変更しない。
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  assert.equal(outcomes.find((item) => item.id === outcome.id)!.status, "active");
  await kit.database.destroy();
});

test("insufficient_evidenceのEvaluationから追加Researchを判断でき、Requestとresearch_requestedを作る", async () => {
  const kit = await setup();
  const { project, intent, evaluation } = await seedEvaluated(kit, ["insufficient_evidence", "met"]);
  assert.equal(evaluation.result, "insufficient_evidence");

  const decided = ok(
    await callTool(
      kit.app,
      "create_direction_decision",
      decisionArgs(project.id, intent.id, {
        type: "additional_research",
        evaluationId: evaluation.id,
        research: { question: "How to observe criterion 1?", scope: "CI logs", completionCondition: "observable metric", budgetTotal: 10 },
      }),
      "str",
    ),
  );
  assert.equal(decided.decision.evaluationId, evaluation.id);
  assert.ok(decided.researchRequest);
  const requested = (await events(kit, project.id)).filter(
    (item) => item.type === "research_requested" && item.researchRequestId === decided.researchRequest.id,
  );
  assert.equal(requested.length, 1);
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  await kit.database.destroy();
});

test("achievedのEvaluationから、Intent完了は完了定義と根拠付きのintent_completeでだけ確定し、次Outcome必要とも区別できる", async () => {
  const kit = await setup();
  const { project, intent, outcome, evidenceIds, evaluation } = await seedEvaluated(kit, ["met", "met"]);
  assert.equal(evaluation.result, "achieved");
  // Executionのacceptedと単一Outcomeの達成だけでは、Intentは達成にならない。
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");

  // 根拠のEvaluationが無いintent_completeは受け付けない。
  const missing = errorOf(await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete" }), "str"));
  assert.equal(missing.code, "VALIDATION_ERROR");
  // 記録だけの判断はEvaluationを根拠にしない。
  const policy = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "policy_proposal", evaluationId: evaluation.id }), "str"),
  );
  assert.equal(policy.code, "VALIDATION_ERROR");

  const args = decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: evaluation.id });
  const completed = ok(await callTool(kit.app, "create_direction_decision", args, "str"));
  assert.equal(completed.decision.type, "intent_complete");
  assert.equal(completed.decision.evaluationId, evaluation.id);
  assert.equal(await intentStatus(kit, project.id, intent.id), "achieved");
  // Outcomeの状態・Executionは変更しない。
  assert.equal((await kit.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id)).status, "active");

  // 応答消失後の再送は同じ判断を返す（Intentは既に達成済みでも）。
  const replay = ok(await callTool(kit.app, "create_direction_decision", args, "str"));
  assert.equal(replay.decision.id, completed.decision.id);

  // 達成済みIntentからは、再計画も新しい評価も起こさない。
  const after = errorOf(
    await callTool(kit.app, "decide_next_outcome", decisionArgs(project.id, intent.id, { outcome: outcomeInput() }), "str"),
  );
  assert.equal(after.code, "CONFLICT");
  const eventCount = (await events(kit, project.id)).length;
  const reevaluated = errorOf(await evaluate(kit, project.id, outcome, ["met", "met"], evidenceIds));
  assert.equal(reevaluated.code, "CONFLICT");
  assert.match(reevaluated.message, /Intent/);
  assert.equal((await events(kit, project.id)).length, eventCount);
  await kit.database.destroy();
});

test("achievedでもIntentが未完了なら、同じEvaluationを根拠に次のOutcomeを判断し、Intentはactiveのまま", async () => {
  const kit = await setup();
  const { project, intent, evaluation } = await seedEvaluated(kit, ["met", "met"]);
  const decided = ok(
    await callTool(kit.app, "decide_next_outcome", decisionArgs(project.id, intent.id, { evaluationId: evaluation.id, outcome: outcomeInput() }), "str"),
  );
  assert.equal(decided.decision.evaluationId, evaluation.id);
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  // 同じEvaluationでIntent完了を重ねて判断できない（再計画と完了は排他）。
  const complete = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: evaluation.id }), "str"),
  );
  assert.equal(complete.code, "CONFLICT");
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  await kit.database.destroy();
});

test("failed / insufficient_evidenceのEvaluation・完了定義の無いIntentでは、intent_completeを拒否してIntentを変えない", async () => {
  const kit = await setup();
  for (const verdicts of [["not_met", "met"], ["insufficient_evidence", "met"]] as Verdict[][]) {
    const { project, intent, evaluation } = await seedEvaluated(kit, verdicts);
    const rejected = errorOf(
      await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: evaluation.id }), "str"),
    );
    assert.equal(rejected.code, "CONFLICT");
    assert.match(rejected.message, /achieved Evaluation/);
    assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  }

  const { project, intent, evaluation } = await seedEvaluated(kit, ["met", "met"], null);
  const rejected = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: evaluation.id }), "str"),
  );
  assert.equal(rejected.code, "CONFLICT");
  assert.match(rejected.message, /completionDefinition/);
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  await kit.database.destroy();
});

test("再評価で古くなったEvaluation・別ProjectのEvaluation・取消済みOutcome・中止したIntentからは遷移しない", async () => {
  const kit = await setup();
  const { project, intent, outcome, evidenceIds, evaluation: stale } = await seedEvaluated(kit, ["not_met", "met"]);
  const latest = ok(await evaluate(kit, project.id, outcome, ["met", "met"], evidenceIds)).evaluation;

  const superseded = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: stale.id }), "str"),
  );
  assert.equal(superseded.code, "CONFLICT");
  assert.match(superseded.message, /superseded/);
  const context = ok(await callTool(kit.app, "get_strategist_context", { projectId: project.id }, "str"));
  assert.deepEqual(context.evaluations.map((item: Record<string, any>) => item.id), [latest.id]);

  const other = await seedEvaluated(kit, ["met", "met"]);
  const foreign = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: other.evaluation.id }), "str"),
  );
  assert.equal(foreign.code, "VALIDATION_ERROR");

  await kit.services.cancelOutcomeUseCase.execute(project.id, intent.id, outcome.id, { reason: "Superseded by a new direction" });
  const cancelled = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: latest.id }), "str"),
  );
  assert.equal(cancelled.code, "CONFLICT");
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");

  await kit.services.abandonIntentUseCase.execute(other.project.id, other.intent.id, { reason: "Direction changed" });
  const abandoned = errorOf(
    await callTool(
      kit.app,
      "decide_next_outcome",
      decisionArgs(other.project.id, other.intent.id, { evaluationId: other.evaluation.id, outcome: outcomeInput() }),
      "str",
    ),
  );
  assert.equal(abandoned.code, "CONFLICT");
  assert.equal(await intentStatus(kit, other.project.id, other.intent.id), "abandoned");
  await kit.database.destroy();
});

test("archived Projectでは、Evaluationを根拠にした再計画・Intent完了を拒否する", async () => {
  const kit = await setup();
  const { project, intent, evaluation } = await seedEvaluated(kit, ["met", "met"]);
  await kit.services.archiveProjectUseCase.execute(project.id, { reason: "Paused" });
  const rejected = errorOf(
    await callTool(kit.app, "create_direction_decision", decisionArgs(project.id, intent.id, { type: "intent_complete", evaluationId: evaluation.id }), "str"),
  );
  assert.equal(rejected.code, "CONFLICT");
  assert.equal(await intentStatus(kit, project.id, intent.id), "active");
  await kit.database.destroy();
});

test("Task 36以前のDBは再初期化でruntime_eventを作り直し、既存イベント・cursorを保ったままoutcome_evaluatedとevaluationIdを受け付ける", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-replan-"));
  const path = join(directory, "compass.db");
  try {
    const first = await setup(path);
    const { project, outcome } = await seedEvaluated(first, ["not_met", "met"]);
    const before = (await events(first, project.id)).filter((item) => item.type !== "outcome_evaluated");

    // Task 35時点の定義（outcome_evaluated・evaluation_idが無い）へ戻す。
    await sql`pragma foreign_keys = off`.execute(first.database);
    await sql`
      create table runtime_event_legacy (
        sequence integer primary key autoincrement,
        id text not null unique,
        event_version integer not null,
        event_type text not null check (event_type in ('research_requested', 'research_completed', 'outcome_confirmed')),
        project_id text not null references project (id) on delete cascade,
        intent_id text references intent (id) on delete cascade,
        research_request_id text references research_request (id) on delete cascade,
        outcome_id text references outcome (id) on delete cascade,
        correlation_id text not null,
        conclusion text,
        created_at integer not null
      )
    `.execute(first.database);
    await sql`
      insert into runtime_event_legacy (sequence, id, event_version, event_type, project_id, intent_id, research_request_id, outcome_id, correlation_id, conclusion, created_at)
      select sequence, id, event_version, event_type, project_id, intent_id, research_request_id, outcome_id, correlation_id, conclusion, created_at from runtime_event where event_type != 'outcome_evaluated'
    `.execute(first.database);
    await sql`drop table runtime_event`.execute(first.database);
    await sql`alter table runtime_event_legacy rename to runtime_event`.execute(first.database);
    await sql`create unique index runtime_event_outcome_type_idx on runtime_event (outcome_id, event_type)`.execute(first.database);
    await sql`drop index direction_decision_evaluation_idx`.execute(first.database);
    await sql`alter table direction_decision drop column evaluation_id`.execute(first.database);
    await sql`pragma foreign_keys = on`.execute(first.database);
    await first.database.destroy();

    const second = await setup(path);
    await initializeSchema(second.database);
    const migrated = await events(second, project.id);
    assert.deepEqual(
      migrated.map((item) => [item.id, item.cursor, item.type, item.outcomeId, item.evaluationId]),
      before.map((item) => [item.id, item.cursor, item.type, item.outcomeId, null]),
    );

    const evidence = (await second.services.getExecutionSummaryUseCase.execute(project.id, outcome.id))!.evidence.map((item) => item.id);
    const evaluation = ok(await evaluate(second, project.id, outcome, ["met", "met"], evidence)).evaluation;
    const after = await events(second, project.id);
    const evaluated = after.filter((item) => item.type === "outcome_evaluated");
    assert.deepEqual(evaluated.map((item) => item.evaluationId), [evaluation.id]);
    assert.ok(evaluated[0]!.cursor > Math.max(...before.map((item) => item.cursor)));
    const decided = ok(
      await callTool(
        second.app,
        "create_direction_decision",
        decisionArgs(project.id, evaluation.intentId, { type: "intent_complete", evaluationId: evaluation.id }),
        "str",
      ),
    );
    assert.equal(decided.decision.evaluationId, evaluation.id);
    await second.database.destroy();

    // 再起動後も、判断済みEvaluation・Intentの達成・イベントが保持される。
    const third = await setup(path);
    assert.equal(await intentStatus(third, project.id, evaluation.intentId), "achieved");
    const context = ok(await callTool(third.app, "get_strategist_context", { projectId: project.id }, "str"));
    assert.equal(context.activeIntent, null);
    assert.equal((await events(third, project.id)).filter((item) => item.type === "outcome_evaluated").length, 1);
    await third.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
