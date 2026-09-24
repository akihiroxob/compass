import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * Outcome Evaluation（Task 35）。Evaluatorとして振る舞うのはtest内のMCP呼び出しだけで、Evaluatorの自動起動は未接続。
 * Evaluationからの再計画・Intent完了はtest/evaluationReplan.test.ts（Task 36）。Lv6の自律運転の実証ではない。
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

const sha = (character: string) => character.repeat(40);
const pullRequest = "https://github.com/example/compass/pull/1";

const grants: readonly (readonly [string, string])[] = [
  ["mgr", "manager"],
  ["wrk", "worker"],
  ["rev", "reviewer"],
  ["rt", "runtime"],
  ["ev", "evaluator"],
  ["str", "strategist"],
  ["res", "researcher"],
];

const seedProject = async ({ services, app }: Kit, name = "Compass") => {
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep execution guarded" });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "Guarded claims", desiredState: "One owner per Task" });
  for (const [principal, role] of grants) await grant(app, project.id, principal, role);
  return { project, intent };
};

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

const createOutcome = async ({ services }: Kit, projectId: string, intentId: string, criteriaCount = 2) =>
  services.createOutcomeUseCase.execute(projectId, intentId, {
    title: next("Outcome"),
    description: "Claims are exclusive.",
    rationale: "Rework",
    successCriteria: Array.from({ length: criteriaCount }, (_, index) => ({
      description: `criterion ${index + 1}`,
      measurement: `Measure ${index + 1}`,
      target: index === 0 ? "= 0" : null,
    })),
  });

/** ManagerがOutcomeを参照するStoryを作り、Taskを1件acceptedまで進める。 */
const executeToAccepted = async (kit: Kit, projectId: string, outcomeId: string) => {
  const { app } = kit;
  const story = ok(await callTool(app, "issue_story", { projectId, title: next("Story"), outcomeId, requestId: next("story") }, "mgr"));
  const task = ok(await callTool(app, "issue_task", { projectId, storyId: story.id, title: next("Task"), requestId: next("task") }, "mgr"));
  const work = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: next("claim") }, "wrk"));
  ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "done", requestId: next("comment") }, "wrk"));
  ok(await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: next("complete") }, "wrk"));
  const review = ok(await callTool(app, "claim_review", { taskId: task.id, requestId: next("review") }, "rev"));
  ok(await callTool(app, "reviewed_task", { taskId: task.id, claimId: review.claimId, requestId: next("reviewed") }, "rev"));
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId: task.id, requestId: next("accept-claim") }, "mgr"));
  ok(await callTool(app, "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: next("accept") }, "mgr"));
};

const reflect = async (app: App, projectId: string, outcomeId: string, evidenceItems: object[] = []) => {
  const changes = ok(await callTool(app, "list_changes", { projectId, afterCursor: 0 }, "rt")) as { nextCursor: number };
  return ok(await callTool(app, "record_execution_evidence", { projectId, outcomeId, changeCursor: changes.nextCursor, evidence: evidenceItems }, "rt"));
};

const evidenceItem = (overrides: Record<string, unknown> = {}) => ({
  kind: "pull_request",
  uri: pullRequest,
  versionHash: sha("a"),
  observedAt: Date.now() - 1_000,
  ...overrides,
});

/** Active Outcome（2 Criteria）・acceptedなExecution・Evidence参照2件が還流済みの状態。 */
const seedEvaluable = async (kit: Kit, name?: string) => {
  const { project, intent } = await seedProject(kit, name);
  const outcome = await createOutcome(kit, project.id, intent.id);
  await executeToAccepted(kit, project.id, outcome.id);
  const reflected = await reflect(kit.app, project.id, outcome.id, [
    evidenceItem(),
    evidenceItem({ kind: "ci", uri: "https://ci.example.com/runs/42", versionHash: null }),
  ]);
  const evidenceIds = reflected.evidence.map((item: Record<string, any>) => item.id as string);
  return { project, intent, outcome, evidenceIds, reflected };
};

/** `principal`にnullを渡すとBearerなしで呼ぶ（undefinedは既定の`ev`になる）。 */
const getContext = (app: App, projectId: string, outcomeId: string, principal: string | null = "ev") =>
  callTool(app, "get_evaluator_context", { projectId, outcomeId }, principal ?? undefined);

const evaluate = (app: App, projectId: string, outcomeId: string, args: object, principal: string | null = "ev") =>
  callTool(app, "record_outcome_evaluation", { projectId, outcomeId, ...args }, principal ?? undefined);

type Verdict = "met" | "not_met" | "insufficient_evidence";
const judgments = (outcome: { readonly successCriteria: readonly { readonly id: string }[] }, verdicts: Verdict[], evidenceIds: string[] = []) =>
  outcome.successCriteria.map((criterion, index) => ({
    criterionId: criterion.id,
    verdict: verdicts[index]!,
    rationale: `observed ${verdicts[index]}`,
    evidenceIds: verdicts[index] === "insufficient_evidence" ? [] : evidenceIds.slice(0, 1),
  }));

test("EvaluatorがInstructionとContextを取得し、Criterionごとの判定から総合結果を根拠・Evidence参照・principalId・runRef付きで保存できる", async () => {
  const kit = await setup();
  const { project, outcome, evidenceIds, reflected } = await seedEvaluable(kit);

  const instructions = ok(await callTool(kit.app, "get_role_instructions", { role: "evaluator", includeShared: true }));
  assert.deepEqual(instructions.files.map((file: Record<string, string>) => file.path), ["agent/role-policy.md", "agent/evaluator.md"]);
  assert.match(instructions.files[1].content, /# Evaluator Role/);

  const context = ok(await getContext(kit.app, project.id, outcome.id));
  assert.equal(context.principalId, "ev");
  assert.equal(context.role, "evaluator");
  assert.equal(context.project.id, project.id);
  assert.equal(context.outcome.id, outcome.id);
  assert.deepEqual(context.outcome.successCriteria.map((criterion: Record<string, any>) => criterion.id), outcome.successCriteria.map((criterion) => criterion.id));
  assert.equal(context.execution.summary.state, "accepted");
  assert.deepEqual(context.execution.evidence, reflected.evidence);
  assert.deepEqual(context.evaluations, []);
  assert.deepEqual(context.unavailable, ["evidence_content"]);

  const before = ok(await callTool(kit.app, "get_outcome_execution_summary", { projectId: project.id, outcomeId: outcome.id }, "rt"));
  const saved = ok(
    await evaluate(kit.app, project.id, outcome.id, {
      requestKey: "eval-1",
      runRef: "run-1",
      criteria: judgments(outcome, ["met", "met"], evidenceIds),
    }),
  );
  assert.equal(saved.recorded, true);
  const evaluation = saved.evaluation;
  assert.equal(evaluation.result, "achieved");
  assert.equal(evaluation.outcomeId, outcome.id);
  assert.equal(evaluation.principalId, "ev");
  assert.equal(evaluation.runRef, "run-1");
  assert.equal(evaluation.requestKey, "eval-1");
  assert.deepEqual(
    evaluation.criteria.map((item: Record<string, any>) => [item.criterionId, item.position, item.description, item.measurement, item.target, item.verdict, item.rationale, item.evidenceIds]),
    outcome.successCriteria.map((criterion, index) => [criterion.id, criterion.position, criterion.description, criterion.measurement, criterion.target, "met", "observed met", [evidenceIds[0]]]),
  );
  // 評価時のsnapshot: Outcome・Execution Summary・Evidence参照。
  assert.equal(evaluation.snapshot.outcome.title, outcome.title);
  assert.equal(evaluation.snapshot.execution.state, "accepted");
  assert.equal(evaluation.snapshot.execution.executionCursor, before.record.summary.executionCursor);
  assert.deepEqual(evaluation.snapshot.evidence.map((item: Record<string, any>) => item.id), evidenceIds);

  // Contextからも取得でき、Outcome・Execution結果は変更されていない。
  const after = ok(await getContext(kit.app, project.id, outcome.id));
  assert.deepEqual(after.evaluations, [evaluation]);
  assert.equal(after.outcome.status, "active");
  assert.deepEqual(after.outcome.successCriteria, context.outcome.successCriteria);
  assert.deepEqual(ok(await callTool(kit.app, "get_outcome_execution_summary", { projectId: project.id, outcomeId: outcome.id }, "rt")), before);
});

test("総合結果はCriterionの判定から導出する: not_metがあればfailed、met以外がinsufficient_evidenceだけならinsufficient_evidence", async () => {
  const kit = await setup();
  const { project, outcome, evidenceIds } = await seedEvaluable(kit);
  const cases: [Verdict[], string][] = [
    [["met", "not_met"], "failed"],
    [["not_met", "insufficient_evidence"], "failed"],
    [["met", "insufficient_evidence"], "insufficient_evidence"],
    [["insufficient_evidence", "insufficient_evidence"], "insufficient_evidence"],
    [["met", "met"], "achieved"],
  ];
  for (const [verdicts, expected] of cases) {
    const saved = ok(await evaluate(kit.app, project.id, outcome.id, { requestKey: next("eval"), runRef: "run", criteria: judgments(outcome, verdicts, evidenceIds) }));
    assert.equal(saved.evaluation.result, expected, verdicts.join(","));
  }
  // 追記のみで、新しい順に並ぶ。
  const context = ok(await getContext(kit.app, project.id, outcome.id));
  assert.deepEqual(context.evaluations.map((item: Record<string, any>) => item.result), ["achieved", "insufficient_evidence", "insufficient_evidence", "failed", "failed"]);
});

test("Evidence不足はinsufficient_evidenceとして保存でき、Evidence参照のないmet / not_metは推測として拒否する", async () => {
  const kit = await setup();
  const { project, outcome, evidenceIds } = await seedEvaluable(kit);

  // Executionがacceptedでも、観測できていなければachievedにならない。
  const insufficient = ok(
    await evaluate(kit.app, project.id, outcome.id, {
      requestKey: "eval-insufficient",
      runRef: "run-1",
      criteria: outcome.successCriteria.map((criterion) => ({ criterionId: criterion.id, verdict: "insufficient_evidence", rationale: "The reference could not be observed", evidenceIds: [] })),
    }),
  );
  assert.equal(insufficient.evaluation.result, "insufficient_evidence");
  assert.equal((await getContext(kit.app, project.id, outcome.id)).structuredContent.execution.summary.state, "accepted");

  for (const verdict of ["met", "not_met"] as const) {
    const error = errorOf(
      await evaluate(kit.app, project.id, outcome.id, {
        requestKey: next("eval"),
        runRef: "run-1",
        criteria: outcome.successCriteria.map((criterion) => ({ criterionId: criterion.id, verdict, rationale: "Looks fine", evidenceIds: [] })),
      }),
    );
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.issues.some((issue: Record<string, string>) => issue.path === "criteria.0.evidenceIds"), JSON.stringify(error));
  }

  // Evidenceを捏造した参照・別Outcomeの参照・根拠の無い判定は保存できない。
  const invalid = [
    { criteria: judgments(outcome, ["met", "met"], ["not-an-evidence-id"]), path: "criteria.0.evidenceIds.0" },
    { criteria: judgments(outcome, ["met", "met"], evidenceIds).map((item) => ({ ...item, rationale: " " })), path: "criteria.0.rationale" },
    { criteria: [{ ...judgments(outcome, ["met", "met"], evidenceIds)[0]!, verdict: "achieved" }, judgments(outcome, ["met", "met"], evidenceIds)[1]!], path: "criteria.0.verdict" },
  ];
  for (const { criteria, path } of invalid) {
    const error = errorOf(await evaluate(kit.app, project.id, outcome.id, { requestKey: next("eval"), runRef: "run-1", criteria }));
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.issues.some((issue: Record<string, string>) => issue.path === path), `${path}: ${JSON.stringify(error)}`);
  }
  // runRef・requestKeyは必須。
  for (const override of [{ runRef: "" }, { requestKey: "" }]) {
    const error = errorOf(await evaluate(kit.app, project.id, outcome.id, { requestKey: next("eval"), runRef: "run-1", criteria: judgments(outcome, ["met", "met"], evidenceIds), ...override }));
    assert.equal(error.code, "VALIDATION_ERROR");
  }
  assert.equal(ok(await getContext(kit.app, project.id, outcome.id)).evaluations.length, 1);
});

test("すべてのSuccess Criterionを1回ずつ判定する必要があり、別Outcomeや存在しないCriterionは拒否する", async () => {
  const kit = await setup();
  const { project, intent, outcome, evidenceIds } = await seedEvaluable(kit);
  const other = await createOutcome(kit, project.id, intent.id);
  const complete = judgments(outcome, ["met", "met"], evidenceIds);

  const cases: { criteria: object[]; path: string }[] = [
    { criteria: [complete[0]!], path: "criteria" },
    { criteria: [complete[0]!, complete[0]!], path: "criteria.1.criterionId" },
    { criteria: [complete[0]!, { ...complete[1]!, criterionId: "unknown-criterion" }], path: "criteria.1.criterionId" },
    { criteria: [], path: "criteria" },
  ];
  for (const { criteria, path } of cases) {
    const error = errorOf(await evaluate(kit.app, project.id, outcome.id, { requestKey: next("eval"), runRef: "run", criteria }));
    assert.equal(error.code, "VALIDATION_ERROR");
    assert.ok(error.issues.some((issue: Record<string, string>) => issue.path === path), `${path}: ${JSON.stringify(error)}`);
  }
  // 別OutcomeのCriterionは、このOutcomeの判定として受け付けない。
  const foreign = judgments(other, ["met", "met"], evidenceIds);
  const error = errorOf(await evaluate(kit.app, project.id, outcome.id, { requestKey: next("eval"), runRef: "run", criteria: foreign }));
  assert.equal(error.code, "VALIDATION_ERROR");
});

test("同じrequestKeyの再送は同じEvaluationを返して増やさず、異なる内容はCONFLICTになる。再起動後も保持される", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-evaluation-"));
  try {
    const path = join(directory, "compass.db");
    const first = await setup(path);
    const { project, outcome, evidenceIds } = await seedEvaluable(first);
    const request = { requestKey: "eval-1", runRef: "run-1", criteria: judgments(outcome, ["met", "not_met"], evidenceIds) };

    const created = ok(await evaluate(first.app, project.id, outcome.id, request));
    assert.equal(created.recorded, true);
    const replayed = ok(await evaluate(first.app, project.id, outcome.id, request));
    assert.equal(replayed.recorded, false);
    assert.deepEqual(replayed.evaluation, created.evaluation);

    // 項目の並び順が違っても同じ内容として扱う。
    const reordered = ok(await evaluate(first.app, project.id, outcome.id, { ...request, criteria: [...request.criteria].reverse() }));
    assert.equal(reordered.evaluation.id, created.evaluation.id);

    // 評価後にExecutionが進んでも、再送は最初のsnapshotのEvaluationを返す。
    await reflect(first.app, project.id, outcome.id, [evidenceItem({ kind: "issue", uri: "https://github.com/example/compass/issues/9", versionHash: null })]);
    assert.deepEqual(ok(await evaluate(first.app, project.id, outcome.id, request)).evaluation, created.evaluation);

    for (const changed of [
      { ...request, runRef: "run-2" },
      { ...request, criteria: judgments(outcome, ["met", "met"], evidenceIds) },
      { ...request, criteria: request.criteria.map((item) => ({ ...item, rationale: "different" })) },
    ]) {
      assert.equal(errorOf(await evaluate(first.app, project.id, outcome.id, changed)).code, "CONFLICT");
    }
    assert.equal(ok(await getContext(first.app, project.id, outcome.id)).evaluations.length, 1);
    await first.database.destroy();

    const restarted = await setup(path);
    const context = ok(await getContext(restarted.app, project.id, outcome.id));
    assert.deepEqual(context.evaluations, [created.evaluation]);
    assert.deepEqual(ok(await evaluate(restarted.app, project.id, outcome.id, request)).evaluation, created.evaluation);
    await restarted.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Evaluator以外のRole・別Project・取消済みGrant・Bearerなしは、Context取得も確定も拒否する", async () => {
  const kit = await setup();
  const { project, outcome, evidenceIds } = await seedEvaluable(kit);
  const other = await seedEvaluable(kit, "Other");
  const request = { requestKey: "eval-1", runRef: "run-1", criteria: judgments(outcome, ["met", "met"], evidenceIds) };

  // Researcher / Strategist / Wacha由来のExecution Role / Runtimeは確定できない。
  for (const principal of ["res", "str", "mgr", "wrk", "rev", "rt", "nobody"]) {
    assert.equal(errorOf(await evaluate(kit.app, project.id, outcome.id, request, principal)).code, "FORBIDDEN", principal);
    assert.equal(errorOf(await getContext(kit.app, project.id, outcome.id, principal)).code, "FORBIDDEN", principal);
  }
  assert.equal(errorOf(await evaluate(kit.app, project.id, outcome.id, request, null)).code, "UNAUTHENTICATED");
  assert.equal(errorOf(await getContext(kit.app, project.id, outcome.id, null)).code, "UNAUTHENTICATED");

  // 別ProjectのGrantでは確定できず、別ProjectのOutcomeは存在を漏らさずNOT_FOUNDになる。
  await grant(kit.app, other.project.id, "ev-other", "evaluator");
  assert.equal(errorOf(await evaluate(kit.app, project.id, outcome.id, request, "ev-other")).code, "FORBIDDEN");
  assert.equal(errorOf(await evaluate(kit.app, other.project.id, outcome.id, request, "ev-other")).code, "NOT_FOUND");
  assert.equal(errorOf(await getContext(kit.app, other.project.id, outcome.id, "ev-other")).code, "NOT_FOUND");
  assert.equal(errorOf(await evaluate(kit.app, project.id, "missing-outcome", request)).code, "NOT_FOUND");

  // 取消したGrantは次の呼び出しから拒否される。
  assert.equal((await kit.app.request(`/api/projects/${project.id}/grants/evaluator/ev`, { method: "DELETE" })).status, 200);
  assert.equal(errorOf(await evaluate(kit.app, project.id, outcome.id, request)).code, "FORBIDDEN");
  assert.equal(errorOf(await getContext(kit.app, project.id, outcome.id)).code, "FORBIDDEN");

  assert.equal(ok(await getContext(kit.app, other.project.id, other.outcome.id, "ev-other")).evaluations.length, 0);
  const count = await kit.database.selectFrom("outcome_evaluation").select(({ fn }) => fn.countAll<number>().as("total")).executeTakeFirstOrThrow();
  assert.equal(Number(count.total), 0);
});

test("Evaluatorは評価できる状態のOutcomeだけを扱う: Execution Summary未還流・取消済みOutcome・archived ProjectはCONFLICT", async () => {
  const kit = await setup();
  const { project, intent } = await seedProject(kit);
  const fresh = await createOutcome(kit, project.id, intent.id);
  const noExecution = { requestKey: "eval-none", runRef: "run", criteria: judgments(fresh, ["insufficient_evidence", "insufficient_evidence"]) };

  // Executionが未着手・未還流のOutcomeは、成功・失敗・不足のいずれとも推測しない。
  const notReflected = errorOf(await evaluate(kit.app, project.id, fresh.id, noExecution));
  assert.equal(notReflected.code, "CONFLICT");
  assert.equal(notReflected.reason, "no_execution_summary");
  assert.equal(ok(await getContext(kit.app, project.id, fresh.id)).execution, null);

  await executeToAccepted(kit, project.id, fresh.id);
  const reflected = await reflect(kit.app, project.id, fresh.id, [evidenceItem()]);
  const evidenceIds = reflected.evidence.map((item: Record<string, any>) => item.id as string);

  // 取消済みのOutcomeは評価できない。
  ok(await callTool(kit.app, "cancel_outcome", { projectId: project.id, intentId: intent.id, outcomeId: fresh.id, reason: "Superseded" }, "str"));
  const onCancelled = errorOf(await evaluate(kit.app, project.id, fresh.id, { requestKey: "eval-cancelled", runRef: "run", criteria: judgments(fresh, ["met", "met"], evidenceIds) }));
  assert.equal(onCancelled.code, "CONFLICT");
  assert.equal(onCancelled.outcomeStatus, "cancelled");

  // archivedなProjectでは確定できない。
  const other = await seedEvaluable(kit, "Archive");
  assert.equal(
    (await kit.app.request(`/api/projects/${other.project.id}/archive`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reason: "Done" }) })).status,
    200,
  );
  const archived = errorOf(await evaluate(kit.app, other.project.id, other.outcome.id, { requestKey: "eval-archived", runRef: "run", criteria: judgments(other.outcome, ["met", "met"], other.evidenceIds) }));
  assert.equal(archived.code, "CONFLICT");
  assert.equal(archived.projectStatus, "archived");
});

test("Evaluatorは Outcome定義・Execution結果・Project / Intent・Grantを変更できない", async () => {
  const kit = await setup();
  const { project, intent, outcome, evidenceIds } = await seedEvaluable(kit);
  const storyBefore = ok(await callTool(kit.app, "list_stories", { projectId: project.id }, "ev"));

  const attempts: [string, object][] = [
    ["create_outcome", { projectId: project.id, intentId: intent.id, title: "x", description: "x", rationale: "x", successCriteria: [{ description: "x", measurement: "x" }] }],
    ["update_outcome", { projectId: project.id, intentId: intent.id, outcomeId: outcome.id, title: "changed" }],
    ["cancel_outcome", { projectId: project.id, intentId: intent.id, outcomeId: outcome.id, reason: "x" }],
    ["record_execution_evidence", { projectId: project.id, outcomeId: outcome.id, changeCursor: 0 }],
    ["fetch_runtime_events", { projectId: project.id }],
    ["issue_story", { projectId: project.id, title: "x", outcomeId: outcome.id, requestId: "story-by-ev" }],
    ["update_project", { projectId: project.id, name: "renamed" }],
    ["create_intent", { projectId: project.id, title: "x", desiredState: "x" }],
    ["update_intent", { projectId: project.id, intentId: intent.id, title: "x" }],
    ["abandon_intent", { projectId: project.id, intentId: intent.id }],
    ["create_direction_decision", { projectId: project.id, intentId: intent.id, type: "intent_complete", judgment: "x", reason: "x", requestKey: "k", runRef: "r" }],
  ];
  for (const [name, args] of attempts) {
    const result = await callTool(kit.app, name, args, "ev");
    assert.equal(result.isError, true, `${name} must be rejected for an evaluator`);
    assert.ok(["FORBIDDEN", "UNAUTHENTICATED"].includes(errorOf(result).code), `${name}: ${JSON.stringify(result.structuredContent)}`);
  }
  assert.deepEqual(ok(await callTool(kit.app, "list_stories", { projectId: project.id }, "ev")), storyBefore);

  ok(await evaluate(kit.app, project.id, outcome.id, { requestKey: "eval-1", runRef: "run", criteria: judgments(outcome, ["met", "met"], evidenceIds) }));
  const stored = ok(await callTool(kit.app, "get_outcome", { projectId: project.id, intentId: intent.id, outcomeId: outcome.id }));
  assert.equal(stored.outcome.title, outcome.title);
  assert.equal(stored.outcome.status, "active");
});

test("Strategist Contextは最新のEvaluationを含み、evaluationをunavailableから外す（Task 36で接続）", async () => {
  const kit = await setup();
  const { project, outcome, evidenceIds } = await seedEvaluable(kit);
  const recorded = ok(await evaluate(kit.app, project.id, outcome.id, { requestKey: "eval-1", runRef: "run", criteria: judgments(outcome, ["met", "met"], evidenceIds) }));

  const strategist = ok(await callTool(kit.app, "get_strategist_context", { projectId: project.id }, "str"));
  assert.equal(strategist.unavailable.includes("evaluation"), false);
  assert.deepEqual(strategist.evaluations.map((item: Record<string, any>) => [item.id, item.result, item.decisionId]), [
    [recorded.evaluation.id, "achieved", null],
  ]);
});
