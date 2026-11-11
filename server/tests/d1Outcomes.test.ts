import assert from "node:assert/strict";
import test from "node:test";
import { type CreateOutcomeInput, type OutcomeProblemInput } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asActivityDatabase, asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1OutcomeRepository } from "../src/infrastructure/repository/d1/D1OutcomeRepository.ts";
import { D1OutcomeTargetProjectRepository } from "../src/infrastructure/repository/d1/D1OutcomeTargetProjectRepository.ts";

const problem: OutcomeProblemInput = { statement: "Problem", evidenceStatus: "insufficient", observation: null,
  causeHypothesis: "Cause", solutionHypothesis: "Solution", evidence: [], evaluationPlan: {
    question: "Does this help?", method: "cognitive_walkthrough", premises: null, observationPeriod: null,
    decisionCriteria: "All steps work", stopCriteria: null } };
const input: CreateOutcomeInput = { title: "Outcome", description: "Change", rationale: "Reason", hypothesis: null,
  intentVersion: 1, successCriteria: [{ description: "Criterion", measurement: "Measure", target: "1" }], problems: [problem] };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    const repository = new D1OutcomeRepository(asDirectionDatabase(context.database), context.binding,
      planD1DirectionActivity(asActivityDatabase(context.database), activityActorContext), () => 100);
    return { ...context, ...organization, workspace, repository };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 Outcome saves children, Activity and Runtime event atomically and returns the committed snapshot", async () => {
  const { runtime, binding, database, workspace, repository, projectRepository } = await setup();
  try {
    await binding.prepare("CREATE TRIGGER reject_event BEFORE INSERT ON runtime_event BEGIN SELECT RAISE(ABORT, 'event failure'); END;").run();
    await assert.rejects(repository.create(workspace.id, "intent", input), /event failure/);
    for (const table of ["outcome", "outcome_problem", "success_criterion", "activity", "runtime_event"] as const) {
      assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0);
    }
    await binding.prepare("DROP TRIGGER reject_event").run();
    const created = await activityActorContext.run({ principalId: "strategist", role: "strategist" }, () => repository.create(workspace.id, "intent", input));
    assert.ok(created.kind === "created");
    assert.equal(created.outcome.problems[0]?.evaluationPlan?.method, "cognitive_walkthrough");
    assert.deepEqual(await repository.findById(workspace.id, "intent", created.outcome.id), created.outcome);
    assert.equal(await repository.findById("other", "intent", created.outcome.id), null);
    assert.equal(await repository.findById(workspace.id, "other", created.outcome.id), null);
    assert.equal((await database.selectFrom("runtime_event").selectAll().executeTakeFirstOrThrow()).outcome_id, created.outcome.id);
    assert.equal((await database.selectFrom("activity").selectAll().executeTakeFirstOrThrow()).principal_id, "strategist");
    const project = await projectRepository.createInWorkspace(workspace.id, { name: "Product", description: null, repositories: [], resources: [] });
    assert.ok(project.kind === "created");
    await new D1OutcomeTargetProjectRepository(asDirectionDatabase(database), binding).add(workspace.id, created.outcome.id, project.project.id);
    assert.deepEqual((await repository.findActiveByTargetProject(workspace.id, project.project.id)).map(({ id }) => id), [created.outcome.id]);
    assert.deepEqual(await repository.findActiveByTargetProject("other", project.project.id), []);
    const extraOutcomes = [];
    // More than 100 Outcomes must not turn child lookups into an oversized IN parameter list.
    for (let i = 0; i < 105; i++) extraOutcomes.push({ id: `extra-${i}`, workspace_id: workspace.id, intent_id: "intent", intent_version: 1,
      title: "Extra", description: "Change", rationale: "Reason", status: "active" as const, revision: 1, created_at: i, updated_at: i });
    await binding.batch(extraOutcomes.map((row) => {
      const query = database.insertInto("outcome").values(row).compile();
      return binding.prepare(query.sql).bind(...query.parameters);
    }));
    assert.equal((await repository.findByWorkspace(workspace.id)).length, 106);
    assert.equal((await repository.findByIntent(workspace.id, "intent")).length, 106);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Outcome edits protect revisions and plan identity; cancellation failure leaves the Outcome active", async () => {
  const { runtime, binding, database, workspace, repository, workspaceRepository } = await setup();
  try {
    const created = await repository.create(workspace.id, "intent", input);
    assert.ok(created.kind === "created");
    const id = created.outcome.id;
    const originalProblem = created.outcome.problems[0]!;
    const nextProblem = { ...problem, id: originalProblem.id, statement: "Revised" };
    const edits = await Promise.all([repository.update(workspace.id, "intent", id, { expectedRevision: 1, problems: [nextProblem] }),
      repository.update(workspace.id, "intent", id, { expectedRevision: 1, title: "Competing" })]);
    assert.deepEqual(edits.map(({ kind }) => kind).sort(), ["changed", "stale_revision"]);
    const updated = await repository.update(workspace.id, "intent", id, { expectedRevision: 2, problems: [nextProblem] });
    assert.ok(updated.kind === "changed");
    assert.equal(updated.outcome.problems[0]?.evaluationPlan?.planId, originalProblem.evaluationPlan?.planId);
    assert.deepEqual(updated.outcome.successCriteria, created.outcome.successCriteria);
    const changedPlan = await repository.update(workspace.id, "intent", id, { expectedRevision: 3,
      problems: [{ ...nextProblem, evaluationPlan: { ...problem.evaluationPlan!, question: "Different question" } }] });
    assert.ok(changedPlan.kind === "changed");
    assert.notEqual(changedPlan.outcome.problems[0]?.evaluationPlan?.planId, originalProblem.evaluationPlan?.planId);
    await assert.rejects(repository.update(workspace.id, "intent", id, { expectedRevision: 4, problems: [{ ...problem, id: "foreign" }] }), /Outcome input is invalid/);
    await database.updateTable("intent").set({ version: 2 }).where("id", "=", "intent").execute();
    assert.deepEqual(await repository.update(workspace.id, "intent", id, { intentVersion: 1 }), { kind: "intent_version_conflict", currentVersion: 2 });
    assert.equal((await repository.update(workspace.id, "intent", id, { expectedRevision: 4, intentVersion: 2 })).kind, "changed");
    await binding.prepare("CREATE TRIGGER reject_cancel BEFORE INSERT ON activity WHEN NEW.type = 'outcome.canceled' BEGIN SELECT RAISE(ABORT, 'cancel failure'); END;").run();
    await assert.rejects(repository.cancel(workspace.id, "intent", id, "reason"), /cancel failure/);
    assert.equal((await repository.findById(workspace.id, "intent", id))?.status, "active");
    await binding.prepare("DROP TRIGGER reject_cancel").run();
    const cancelled = await repository.cancel(workspace.id, "intent", id, "reason");
    assert.ok(cancelled.kind === "changed");
    assert.equal(cancelled.outcome.cancelReason, "reason");
    assert.deepEqual(await repository.cancel(workspace.id, "intent", id, "again"), { kind: "not_active", status: "cancelled" });
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.create(workspace.id, "intent", input), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Outcome evidence resolves Research and only permits already-linked superseded synthesis", async () => {
  const { runtime, binding, database, workspace, repository } = await setup();
  try {
    await database.insertInto("research_request").values({ id: "research", workspace_id: workspace.id, request_key: "research", input_hash: "hash",
      kind: "decision", origin_intent_id: "intent", question: "Question", scope: "Scope", completion_condition: "Done", budget_total: 10,
      budget_used: 0, status: "running", correlation_id: "correlation", created_at: 1, updated_at: 1 }).execute();
    const synthesis = { workspace_id: workspace.id, request_id: "research", input_hash: "hash", risks: "[]", options: "[]", unknowns: "[]",
      valid_as_of: 1, principal_id: "researcher", run_ref: "run", created_at: 1 };
    await database.insertInto("research_synthesis").values({ ...synthesis, id: "s1", request_key: "s1", version: 1, supersedes_id: null, conclusion: "First" }).execute();
    const withEvidence = { ...problem, evidence: [{ kind: "research_synthesis" as const, id: "s1" }] };
    const created = await repository.create(workspace.id, "intent", { ...input, problems: [withEvidence] });
    assert.ok(created.kind === "created");
    assert.equal(created.outcome.problems[0]?.evidence[0]?.summary, "First");
    await database.insertInto("research_synthesis").values({ ...synthesis, id: "s2", request_key: "s2", version: 2, supersedes_id: "s1", conclusion: "Second" }).execute();
    const edited = await repository.update(workspace.id, "intent", created.outcome.id, { expectedRevision: 1,
      problems: [{ ...withEvidence, id: created.outcome.problems[0]!.id }] });
    assert.ok(edited.kind === "changed");
    assert.equal(edited.outcome.problems[0]?.evidence[0]?.superseded, true);
    await assert.rejects(repository.create(workspace.id, "intent", { ...input, problems: [withEvidence] }), /superseded/);
    await assert.rejects(repository.create(workspace.id, "intent", { ...input, problems: [{ ...problem,
      evidence: [{ kind: "research_finding", id: "missing" }] }] }), /Outcome input is invalid/);
    await database.insertInto("research_result").values({ id: "result", workspace_id: workspace.id, request_id: "research", sequence: 1,
      request_key: "result", input_hash: "hash", summary: "Summary", unknowns: "[]", options: "[]", risks: "[]", budget_used: 0,
      principal_id: "researcher", run_ref: "run", created_at: 1 }).execute();
    for (let i = 0; i < 9; i++) {
      await database.insertInto("research_finding").values({ id: `finding-${i}`, workspace_id: workspace.id, request_id: "research", result_id: "result",
        position: i, statement: `Finding ${i}`, confidence: "medium", observed_at: 1, principal_id: "researcher", run_ref: "run", created_at: 1 }).execute();
    }
    // 100 references produce over 100 preconditions; every SQL still stays within D1's bind limit.
    const maxProblems = Array.from({ length: 10 }, (_, index) => ({ ...problem, statement: `Problem ${index}`,
      evidence: [{ kind: "research_synthesis" as const, id: "s2" }, ...Array.from({ length: 9 }, (_, i) => ({ kind: "research_finding" as const, id: `finding-${i}` }))] }));
    const maximum = await repository.create(workspace.id, "intent", { ...input, problems: maxProblems });
    assert.ok(maximum.kind === "created");
    assert.equal(maximum.outcome.problems.flatMap(({ evidence }) => evidence).length, 100);
    let inject = true;
    const racingBinding = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (inject) {
          inject = false;
          await database.insertInto("research_synthesis").values({ ...synthesis, id: "s3", request_key: "s3", version: 3,
            supersedes_id: "s2", conclusion: "New evidence arrived before commit" }).execute();
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const racingRepository = new D1OutcomeRepository(asDirectionDatabase(database), racingBinding,
      planD1DirectionActivity(asActivityDatabase(database), activityActorContext));
    const count = (await repository.findByWorkspace(workspace.id)).length;
    await assert.rejects(racingRepository.create(workspace.id, "intent", { ...input,
      problems: [{ ...problem, evidence: [{ kind: "research_synthesis", id: "s2" }] }] }), /superseded/);
    assert.equal((await repository.findByWorkspace(workspace.id)).length, count);
  } finally { await database.destroy(); await runtime.dispose(); }
});
