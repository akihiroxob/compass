import assert from "node:assert/strict";
import test from "node:test";
import { planDirectionDecisionRecord, researchRequestRow, planResearchResultRecord, type CreateDirectionDecisionInput,
  type DecideNextOutcomeInput, type IntentResearchSummary } from "@compass/direction";
import { inputHash } from "@compass/shared";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asActivityDatabase, asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1DirectionDecisionRepository } from "../src/infrastructure/repository/d1/D1DirectionDecisionRepository.ts";

const brief: IntentResearchSummary = { requests: [], syntheses: [], conflicts: [] };
const common = { intentId: "intent", intentVersion: 1, judgment: "Judgment", reason: "Reason", options: [], usedSyntheses: [],
  usedFindingIds: [], requestKey: "decision", runRef: "run", principalId: "strategist" };
const research = { question: "Question", scope: "Scope", completionCondition: "Evidence exists", budgetTotal: 10, deadlineAt: 200 };
const nextInput: DecideNextOutcomeInput & { principalId: string } = { ...common, outcome: { title: "Outcome", description: "Change", hypothesis: null,
  rationale: "Reason", successCriteria: [{ description: "Criterion", measurement: "Measure", target: null }], problems: [] } };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    let now = 100;
    const activity = planD1DirectionActivity(asActivityDatabase(context.database), activityActorContext);
    const repository = new D1DirectionDecisionRepository(asDirectionDatabase(context.database), context.binding, activity, () => now);
    return { ...context, ...organization, workspace, repository, activity, setNow: (at: number) => { now = at; } };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 Decision and additional Research are atomic, idempotent and support maximum reference counts", async () => {
  const { runtime, binding, database, workspace, repository, workspaceRepository, setNow } = await setup();
  try {
    const input: CreateDirectionDecisionInput & { principalId: string } = { ...common, type: "additional_research", research };
    await binding.prepare("CREATE TRIGGER reject_requested BEFORE INSERT ON runtime_event BEGIN SELECT RAISE(ABORT, 'event failure'); END;").run();
    await assert.rejects(repository.create(workspace.id, brief, input), /event failure/);
    for (const table of ["direction_decision", "research_request", "activity", "runtime_event"] as const) assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_requested").run();
    const replies = await Promise.all([repository.create(workspace.id, brief, input), repository.create(workspace.id, brief, input)]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    const created = replies[0]!;
    assert.ok("decision" in created && created.researchRequest);
    assert.equal(created.researchRequest.correlationId, `decision:${created.decision.id}`);
    assert.deepEqual(created.decision.intentBriefSnapshot, brief);
    assert.deepEqual(await repository.create(workspace.id, brief, { ...input, reason: "Changed" }), { kind: "key_conflict", requestKey: input.requestKey });
    setNow(201);
    assert.equal((await repository.create(workspace.id, brief, input)).kind, "replayed");
    assert.deepEqual(await repository.create(workspace.id, brief, { ...input, requestKey: "late" }), { kind: "deadline_in_past", deadlineAt: 200 });
    const direction = asDirectionDatabase(database);
    const request = researchRequestRow(workspace.id, { ...research, requestKey: "bulk", kind: "decision", originIntentId: "intent", originOutcomeId: null }, 100);
    await database.insertInto("research_request").values(request).execute();
    const findings: string[] = [];
    for (let n = 0; n < 2; n++) {
      const plan = planResearchResultRecord(direction, workspace.id, request.id, { summary: "Findings", budgetUsed: 0, requestKey: `result-${n}`,
        principalId: "researcher", runRef: "run", unknowns: [], options: [], risks: [],
        evidenceRefs: [{ kind: "url", uri: "https://example.test", retrievedAt: 100, resourceId: null, versionHash: null }],
        findings: Array.from({ length: 50 }, (_, i) => ({ statement: `Finding ${i}`, confidence: "high", observedAt: 100,
          expiresAt: null, evidenceIndexes: [0], conflictsWithFindingIds: [] })) }, n + 1, 100);
      await binding.batch(plan.mutations.map((query) => binding.prepare(query.sql).bind(...query.parameters)));
      findings.push(...plan.result.findings.map(({ id }) => id));
    }
    const withReferences = await repository.create(workspace.id, brief, { ...common, requestKey: "max-refs", type: "policy_proposal", usedFindingIds: findings });
    assert.ok(withReferences.kind === "created");
    assert.deepEqual(withReferences.decision.usedFindingIds, findings);
    const bulk = Array.from({ length: 105 }, (_, i) => {
      const input = { ...common, requestKey: `bulk-${i}` };
      return planDirectionDecisionRecord(direction, workspace.id, `bulk-${i}`, "policy_proposal", null, brief, input, inputHash(input), 100);
    });
    await binding.batch(bulk.flatMap(({ mutations }) => mutations).map((query) => binding.prepare(query.sql).bind(...query.parameters)));
    assert.equal((await repository.findByIntent(workspace.id, "intent")).length, 107);
    assert.deepEqual(await repository.findByIntent("other", "intent"), []);
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.create(workspace.id, brief, input), { kind: "workspace_archived", workspaceId: workspace.id });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 next Outcome Decision rolls back Outcome, children and events together and converges on retry", async () => {
  const { runtime, binding, database, workspace, repository } = await setup();
  try {
    await binding.prepare("CREATE TRIGGER reject_decision BEFORE INSERT ON direction_decision BEGIN SELECT RAISE(ABORT, 'decision failure'); END;").run();
    await assert.rejects(repository.decideNextOutcome(workspace.id, brief, nextInput), /decision failure/);
    for (const table of ["direction_decision", "outcome", "success_criterion", "activity", "runtime_event"] as const) assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_decision").run();
    const replies = await Promise.all([repository.decideNextOutcome(workspace.id, brief, nextInput), repository.decideNextOutcome(workspace.id, brief, nextInput)]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    const created = replies[0]!;
    assert.ok("decision" in created);
    assert.equal(created.outcome.originDecisionId, created.decision.id);
    assert.equal(created.decision.outcomeId, created.outcome.id);
    assert.equal(created.outcome.successCriteria.length, 1);
    assert.equal((await database.selectFrom("runtime_event").selectAll().execute()).length, 1);
    assert.deepEqual(await repository.decideNextOutcome(workspace.id, brief, { ...nextInput, requestKey: "old-version", intentVersion: 2 }), { kind: "intent_version_conflict", currentVersion: 1 });
    assert.deepEqual(await repository.decideNextOutcome("other", brief, nextInput), { kind: "intent_not_found" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 evaluation Decisions reject stale or reused evaluations and atomically complete the Intent", async () => {
  const { runtime, binding, database, workspace, repository, activity } = await setup();
  try {
    const completed = { ...common, type: "intent_complete" as const, evaluationId: "evaluation" };
    assert.deepEqual(await repository.create(workspace.id, brief, completed), { kind: "no_completion_definition" });
    await database.updateTable("intent").set({ completion_definition: "Success" }).where("id", "=", "intent").execute();
    const next = await repository.decideNextOutcome(workspace.id, brief, nextInput);
    assert.ok(next.kind === "created");
    const evaluation = (id: string, result: "failed" | "achieved", at: number) => ({ id, workspace_id: workspace.id, outcome_id: next.outcome.id,
      intent_id: "intent", intent_version: 1, result, method: "Inspection", target_version: "v1", limitations: "[]", problem_ids: "[]", problem_plans: "[]",
      criteria: "[]", snapshot: "{}", principal_id: "evaluator", run_ref: "run", request_key: id, input_hash: id, created_at: at });
    await database.insertInto("outcome_evaluation").values(evaluation("evaluation", "failed", 100)).execute();
    assert.deepEqual(await repository.create(workspace.id, brief, { ...completed, requestKey: "complete" }), { kind: "evaluation_result_mismatch", evaluationId: "evaluation", result: "failed" });
    await database.insertInto("outcome_evaluation").values(evaluation("new", "achieved", 200)).execute();
    assert.deepEqual(await repository.create(workspace.id, brief, { ...common, type: "policy_proposal", requestKey: "old", evaluationId: "evaluation" }), { kind: "evaluation_not_latest", evaluationId: "evaluation", latestEvaluationId: "new" });
    let inject = true;
    const racingBinding = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (inject) { inject = false; await database.insertInto("outcome_evaluation").values(evaluation("race", "achieved", 300)).execute(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const racing = new D1DirectionDecisionRepository(asDirectionDatabase(database), racingBinding, activity);
    assert.deepEqual(await racing.create(workspace.id, brief, { ...common, type: "policy_proposal", requestKey: "race", evaluationId: "new" }), { kind: "evaluation_not_latest", evaluationId: "new", latestEvaluationId: "race" });
    const input = { ...common, type: "policy_proposal" as const, evaluationId: "race" };
    const replies = await Promise.all([repository.create(workspace.id, brief, { ...input, requestKey: "first" }), repository.create(workspace.id, brief, { ...input, requestKey: "second" })]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["created", "evaluation_already_decided"]);
    await database.insertInto("outcome_evaluation").values(evaluation("finish", "achieved", 400)).execute();
    await binding.prepare("CREATE TRIGGER reject_complete AFTER UPDATE ON intent WHEN NEW.status = 'achieved' BEGIN SELECT RAISE(ABORT, 'completion failure'); END;").run();
    const finish = { ...completed, requestKey: "finish", evaluationId: "finish" };
    const count = (await repository.findByIntent(workspace.id, "intent")).length;
    await assert.rejects(repository.create(workspace.id, brief, finish), /completion failure/);
    assert.equal((await database.selectFrom("intent").select("status").executeTakeFirstOrThrow()).status, "active");
    assert.equal((await repository.findByIntent(workspace.id, "intent")).length, count);
    await binding.prepare("DROP TRIGGER reject_complete").run();
    assert.equal((await repository.create(workspace.id, brief, finish)).kind, "created");
    assert.equal((await database.selectFrom("intent").select("status").executeTakeFirstOrThrow()).status, "achieved");
    assert.equal((await repository.create(workspace.id, brief, finish)).kind, "replayed");
  } finally { await database.destroy(); await runtime.dispose(); }
});
