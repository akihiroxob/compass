import assert from "node:assert/strict";
import test from "node:test";
import { snapshotEvaluationTargets, type RecordOutcomeExecutionInput, type RecordOutcomeEvaluationInput } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asActivityDatabase, asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1OutcomeTargetProjectRepository } from "../src/infrastructure/repository/d1/D1OutcomeTargetProjectRepository.ts";
import { D1OutcomeExecutionRepository } from "../src/infrastructure/repository/d1/D1OutcomeExecutionRepository.ts";
import { D1OutcomeEvaluationRepository } from "../src/infrastructure/repository/d1/D1OutcomeEvaluationRepository.ts";
import { readD1EvaluationTargets } from "../src/infrastructure/repository/d1/readD1EvaluationTargets.ts";

const evidence = (uri = "https://example.test/1") => ({ kind: "url" as const, uri, versionHash: null, observedAt: 100 });
const reflection: RecordOutcomeExecutionInput = { outcomeId: "outcome", correlationId: "outcome:outcome", state: "accepted", stories: [], executionCursor: 10,
  changeCursor: 10, evidence: [evidence()], principalId: "runtime", at: 100 };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    const input = { name: "Product", description: null, repositories: [], resources: [] };
    const a = await organization.projectRepository.createInWorkspace(workspace.id, input), b = await organization.projectRepository.createInWorkspace(workspace.id, input);
    assert.ok(a.kind === "created" && b.kind === "created");
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    await context.database.insertInto("outcome").values({ id: "outcome", workspace_id: workspace.id, intent_id: "intent", intent_version: 1,
      title: "Outcome", description: "Change", rationale: "Reason", status: "active", revision: 1, created_at: 1, updated_at: 1 }).execute();
    const direction = asDirectionDatabase(context.database);
    const targets = new D1OutcomeTargetProjectRepository(direction, context.binding);
    await targets.add(workspace.id, "outcome", a.project.id);
    const activity = planD1DirectionActivity(asActivityDatabase(context.database), activityActorContext);
    return { ...context, ...organization, workspace, a: a.project, b: b.project, targets, activity,
      execution: new D1OutcomeExecutionRepository(direction, context.binding),
      evaluation: new D1OutcomeEvaluationRepository(direction, context.binding, activity) };
  } catch (error) { await context.runtime.dispose(); throw error; }
};
type Kit = Awaited<ReturnType<typeof setup>>;
const evaluationInput = async (kit: Kit): Promise<RecordOutcomeEvaluationInput> => ({ intentId: "intent", result: "achieved", criteria: [], problemPlans: [], at: 200,
  request: { outcomeId: "outcome", requestKey: "evaluation", principalId: "evaluator", runRef: "run", method: "quantitative_observation", targetVersion: "v1",
    limitations: "Limited", problemIds: [], planIds: {}, criteria: [] },
  snapshot: { outcome: { title: "Outcome", description: "Change", hypothesis: null, status: "active" },
    targets: snapshotEvaluationTargets((await readD1EvaluationTargets(asDirectionDatabase(kit.database), kit.binding, kit.workspace.id, "outcome")).targets) } });

test("D1 Execution reflection deduplicates concurrent evidence, preserves cursors and rolls back failed evidence", async () => {
  const kit = await setup();
  const { runtime, binding, database, workspace, a, execution, targets } = kit;
  try {
    const replies = await Promise.all([execution.record(workspace.id, a.id, reflection), execution.record(workspace.id, a.id, reflection)]);
    assert.ok(replies.every((result) => result.kind === "recorded"));
    assert.deepEqual(replies.map((result) => result.kind === "recorded" ? result.evidenceAdded : -1).sort(), [0, 1]);
    const stale = await execution.record(workspace.id, a.id, { ...reflection, executionCursor: 2, changeCursor: 2, state: "rejected", evidence: [evidence("https://example.test/stale")] });
    assert.ok(stale.kind === "recorded");
    assert.equal(stale.staleInput, true);
    assert.equal(stale.summaryChanged, false);
    assert.equal(stale.record.summary.state, "accepted");
    assert.equal(stale.record.summary.executionCursor, 10);
    const observed = await execution.record(workspace.id, a.id, { ...reflection, changeCursor: 20, state: "rejected", evidence: [] });
    assert.ok(observed.kind === "recorded");
    assert.equal(observed.record.summary.observedCursor, 20);
    assert.equal(observed.record.summary.state, "accepted");
    await binding.prepare("CREATE TRIGGER reject_execution_evidence BEFORE INSERT ON outcome_execution_evidence BEGIN SELECT RAISE(ABORT, 'evidence failure'); END;").run();
    await assert.rejects(execution.record(workspace.id, a.id, { ...reflection, executionCursor: 30, changeCursor: 30, evidence: [evidence("https://example.test/fail")] }), /evidence failure/);
    assert.equal((await execution.find(workspace.id, a.id, "outcome"))?.summary.executionCursor, 10);
    await binding.prepare("DROP TRIGGER reject_execution_evidence").run();
    let calls = 0;
    const racing = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (++calls === 2) await targets.remove(workspace.id, "outcome", a.id);
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const rejected = await new D1OutcomeExecutionRepository(asDirectionDatabase(database), racing).record(workspace.id, a.id, { ...reflection, executionCursor: 30, changeCursor: 30 });
    assert.deepEqual(rejected, { kind: "not_target_project" });
    assert.equal((await execution.findByOutcome(workspace.id, "outcome"))[0]?.evidence.length, 2);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Execution evidence limits remain per Project and safe under concurrent additions", async () => {
  const { runtime, database, workspace, a, b, targets, execution, projectRepository } = await setup();
  try {
    const initial = Array.from({ length: 199 }, (_, i) => evidence(`https://example.test/${i}`));
    assert.equal((await execution.record(workspace.id, a.id, { ...reflection, evidence: initial })).kind, "recorded");
    const replies = await Promise.all([execution.record(workspace.id, a.id, { ...reflection, evidence: [evidence("https://example.test/new-a")] }),
      execution.record(workspace.id, a.id, { ...reflection, evidence: [evidence("https://example.test/new-b")] })]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["evidence_limit_exceeded", "recorded"]);
    assert.equal((await execution.find(workspace.id, a.id, "outcome"))?.evidence.length, 200);
    await targets.add(workspace.id, "outcome", b.id);
    assert.equal((await execution.record(workspace.id, b.id, reflection)).kind, "recorded");
    await projectRepository.archive(b.id, "done");
    assert.deepEqual(await execution.record(workspace.id, b.id, reflection), { kind: "project_archived" });
    await assert.rejects(execution.record("other", a.id, reflection), /was not found in Workspace/);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Evaluation, Runtime event and Activity are atomic and duplicate requests replay after archive", async () => {
  const kit = await setup();
  const { runtime, binding, database, workspace, a, execution, evaluation, workspaceRepository } = kit;
  try {
    await execution.record(workspace.id, a.id, reflection);
    const input = await evaluationInput(kit);
    await binding.prepare("CREATE TRIGGER reject_evaluation_event BEFORE INSERT ON runtime_event BEGIN SELECT RAISE(ABORT, 'event failure'); END;").run();
    await assert.rejects(evaluation.record(workspace.id, input), /event failure/);
    assert.equal((await evaluation.findByOutcome(workspace.id, "outcome")).length, 0);
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_evaluation_event").run();
    const replies = await Promise.all([evaluation.record(workspace.id, input), evaluation.record(workspace.id, input)]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    assert.equal((await database.selectFrom("runtime_event").selectAll().execute()).length, 1);
    assert.equal((await evaluation.findLatestByIntent(workspace.id, "intent")).length, 1);
    assert.deepEqual(await evaluation.record(workspace.id, { ...input, request: { ...input.request, targetVersion: "changed" } }), { kind: "key_conflict", requestKey: "evaluation" });
    await workspaceRepository.archive(workspace.id, "done");
    assert.equal((await evaluation.record(workspace.id, input)).kind, "replayed");
    assert.deepEqual(await evaluation.record(workspace.id, { ...input, request: { ...input.request, requestKey: "new" } }), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

for (const change of ["target", "summary", "evidence", "archive"] as const) {
  test(`D1 Evaluation rejects ${change} changes arriving immediately before commit`, async () => {
    const kit = await setup();
    const { runtime, binding, database, workspace, a, b, execution, evaluation, targets, activity, projectRepository } = kit;
    try {
      await execution.record(workspace.id, a.id, reflection);
      const input = await evaluationInput(kit);
      let calls = 0;
      const racing = new Proxy(binding, { get(target, property) {
        if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
          if (++calls === 2) {
            if (change === "target") await targets.add(workspace.id, "outcome", b.id);
            if (change === "summary") await execution.record(workspace.id, a.id, { ...reflection, executionCursor: 20, changeCursor: 20 });
            if (change === "evidence") await execution.record(workspace.id, a.id, { ...reflection, evidence: [evidence("https://example.test/new")] });
            if (change === "archive") await projectRepository.archive(a.id, "done");
          }
          return target.batch(statements);
        };
        const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
      } });
      const result = await new D1OutcomeEvaluationRepository(asDirectionDatabase(database), racing, activity).record(workspace.id, input);
      assert.deepEqual(result, { kind: "targets_changed" });
      assert.deepEqual(await evaluation.findByOutcome(workspace.id, "outcome"), []);
    } finally { await database.destroy(); await runtime.dispose(); }
  });
}
