import assert from "node:assert/strict";
import test from "node:test";
import { planResearchResultRecord, type CreateResearchRequestInput, type RegisterResearchResultInput, type RegisterResearchSynthesisInput } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asActivityDatabase, asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../src/infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1ResearchRepository } from "../src/infrastructure/repository/d1/D1ResearchRepository.ts";

const requestInput: CreateResearchRequestInput = { requestKey: "request", kind: "decision", originIntentId: "intent", originOutcomeId: null,
  question: "Question", scope: "Scope", completionCondition: "Evidence exists", budgetTotal: 10, deadlineAt: 200 };
const resultInput: RegisterResearchResultInput = { requestKey: "result", principalId: "researcher", runRef: "run", summary: "Result", budgetUsed: 6,
  unknowns: [], options: [], risks: [], evidenceRefs: [{ kind: "url", uri: "https://example.test", retrievedAt: 100, versionHash: null, resourceId: null }],
  findings: [{ statement: "Finding", confidence: "high", observedAt: 100, expiresAt: 150, evidenceIndexes: [0], conflictsWithFindingIds: [] }] };
const synthesisInput = (findingIds: string[]): RegisterResearchSynthesisInput => ({ requestKey: "synthesis", principalId: "researcher", runRef: "run",
  conclusion: "Conclusion", findingIds, risks: [], options: [], unknowns: [], validAsOf: 100, supersedesId: null });
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    let now = 100;
    const repository = new D1ResearchRepository(asDirectionDatabase(context.database), context.binding,
      planD1DirectionActivity(asActivityDatabase(context.database), activityActorContext), () => now);
    return { ...context, ...organization, workspace, repository, setNow: (at: number) => { now = at; } };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 Research request creation is atomic and concurrent retries preserve the original receipt after the deadline", async () => {
  const { runtime, binding, database, workspace, repository, workspaceRepository, setNow } = await setup();
  try {
    await binding.prepare("CREATE TRIGGER reject_requested BEFORE INSERT ON runtime_event BEGIN SELECT RAISE(ABORT, 'event failure'); END;").run();
    await assert.rejects(repository.createRequest(workspace.id, requestInput), /event failure/);
    assert.equal((await database.selectFrom("research_request").selectAll().execute()).length, 0);
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_requested").run();
    const results = await Promise.all([repository.createRequest(workspace.id, requestInput), repository.createRequest(workspace.id, requestInput)]);
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["created", "replayed"]);
    const created = results[0]!;
    assert.ok("request" in created);
    assert.equal((await database.selectFrom("runtime_event").selectAll().execute()).length, 1);
    assert.deepEqual(await repository.createRequest(workspace.id, { ...requestInput, question: "Changed" }), { kind: "key_conflict", requestKey: "request" });
    assert.deepEqual(await repository.createRequest(workspace.id, { ...requestInput, requestKey: "other", originIntentId: "missing" }), { kind: "intent_not_found" });
    assert.equal(await repository.findRequestDetail("other", created.request.id), null);
    setNow(201);
    assert.equal((await repository.createRequest(workspace.id, requestInput)).kind, "replayed");
    assert.deepEqual(await repository.createRequest(workspace.id, { ...requestInput, requestKey: "late" }), { kind: "deadline_in_past", deadlineAt: 200 });
    assert.deepEqual(await repository.registerResult(workspace.id, created.request.id, resultInput), { kind: "deadline_passed", deadlineAt: 200 });
    assert.deepEqual(await repository.registerSynthesis(workspace.id, created.request.id, synthesisInput([])), { kind: "deadline_passed", deadlineAt: 200 });
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.createRequest(workspace.id, requestInput), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Research results and synthesis protect budgets, sequence, references and concurrent supersession", async () => {
  const { runtime, binding, database, workspace, repository, setNow } = await setup();
  try {
    const request = await repository.createRequest(workspace.id, requestInput);
    assert.ok(request.kind === "created");
    const id = request.request.id;
    assert.deepEqual(await repository.complete(workspace.id, id, { conclusion: "completed", stopReason: null }), { kind: "incomplete", missing: "result" });
    await binding.prepare("CREATE TRIGGER reject_finding BEFORE INSERT ON research_finding BEGIN SELECT RAISE(ABORT, 'finding failure'); END;").run();
    await assert.rejects(repository.registerResult(workspace.id, id, resultInput), /finding failure/);
    for (const table of ["research_result", "research_finding", "research_evidence_ref"] as const) assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0);
    assert.equal((await repository.findRequestDetail(workspace.id, id))?.request.budgetUsed, 0);
    await binding.prepare("DROP TRIGGER reject_finding").run();
    const concurrent = await Promise.all([repository.registerResult(workspace.id, id, resultInput), repository.registerResult(workspace.id, id, { ...resultInput, requestKey: "competing" })]);
    assert.deepEqual(concurrent.map(({ kind }) => kind).sort(), ["budget_exceeded", "registered"]);
    const registered = concurrent.find((result) => result.kind === "registered")!;
    assert.ok(registered.kind === "registered");
    assert.equal(registered.result.sequence, 1);
    const detail = await repository.findRequestDetail(workspace.id, id);
    assert.equal(detail?.request.budgetUsed, 6);
    assert.equal(detail?.request.status, "running");
    assert.deepEqual(detail?.results, [registered.result]);
    assert.deepEqual(await repository.complete(workspace.id, id, { conclusion: "completed", stopReason: null }), { kind: "incomplete", missing: "synthesis" });
    assert.deepEqual(await repository.registerSynthesis(workspace.id, id, synthesisInput(["missing"])), { kind: "invalid_reference", reference: "finding", ids: ["missing"] });
    const synthesis = await repository.registerSynthesis(workspace.id, id, synthesisInput(registered.result.findings.map(({ id }) => id)));
    assert.ok(synthesis.kind === "registered");
    const next = { ...synthesisInput(registered.result.findings.map(({ id }) => id)), supersedesId: synthesis.synthesis.id, requestKey: "second" };
    const successors = await Promise.all([repository.registerSynthesis(workspace.id, id, next), repository.registerSynthesis(workspace.id, id, { ...next, requestKey: "other" })]);
    assert.deepEqual(successors.map(({ kind }) => kind).sort(), ["already_superseded", "registered"]);
    await binding.prepare("CREATE TRIGGER reject_completed BEFORE INSERT ON runtime_event WHEN NEW.event_type = 'research_completed' BEGIN SELECT RAISE(ABORT, 'completion failure'); END;").run();
    await assert.rejects(repository.complete(workspace.id, id, { conclusion: "completed", stopReason: "Enough" }), /completion failure/);
    assert.equal((await repository.findRequestDetail(workspace.id, id))?.request.status, "running");
    await binding.prepare("DROP TRIGGER reject_completed").run();
    assert.equal((await repository.complete(workspace.id, id, { conclusion: "completed", stopReason: "Enough" })).kind, "closed");
    assert.deepEqual(await repository.cancel(workspace.id, id, "late"), { kind: "not_open", status: "completed" });
    setNow(201);
    const winningKey = concurrent[0]?.kind === "registered" ? "result" : "competing";
    assert.equal((await repository.registerResult(workspace.id, id, { ...resultInput, requestKey: winningKey })).kind, "replayed");
    assert.equal((await repository.registerSynthesis(workspace.id, id, synthesisInput(registered.result.findings.map(({ id }) => id)))).kind, "replayed");
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Research Brief resolves cross-request evidence, expiry, supersession and incoming conflicts", async () => {
  const { runtime, binding, database, workspace, repository, setNow } = await setup();
  try {
    const a = await repository.createRequest(workspace.id, { ...requestInput, deadlineAt: null, budgetTotal: 1000 });
    const b = await repository.createRequest(workspace.id, { ...requestInput, deadlineAt: null, requestKey: "second" });
    assert.ok(a.kind === "created" && b.kind === "created");
    const ar = await repository.registerResult(workspace.id, a.request.id, resultInput);
    assert.ok(ar.kind === "registered");
    const af = ar.result.findings[0]!.id;
    const as = await repository.registerSynthesis(workspace.id, a.request.id, synthesisInput([af]));
    assert.ok(as.kind === "registered");
    const br = await repository.registerResult(workspace.id, b.request.id, { ...resultInput,
      findings: [{ ...resultInput.findings[0]!, conflictsWithFindingIds: [af] }] });
    assert.ok(br.kind === "registered");
    const bf = br.result.findings[0]!.id;
    const bs = await repository.registerSynthesis(workspace.id, b.request.id, { ...synthesisInput([bf, af]), supersedesId: as.synthesis.id, validAsOf: 110 });
    assert.ok(bs.kind === "registered");
    setNow(150);
    const brief = await repository.findIntentResearchSummary(workspace.id, "intent");
    assert.deepEqual(brief.syntheses.map(({ synthesisId, stale }) => [synthesisId, stale]), [[bs.synthesis.id, true]]);
    assert.deepEqual(brief.conflicts, [{ findingId: bf, conflictsWithFindingId: af }]);
    const related = await repository.findRelatedFindings(workspace.id, a.request.id, 10);
    assert.deepEqual(related.findings.map(({ id }) => id), [bf]);
    assert.equal(related.evidenceRefs.length, 1);
    await repository.cancel(workspace.id, b.request.id, "stop");
    const afterCancel = await repository.findIntentResearchSummary(workspace.id, "intent");
    assert.deepEqual(afterCancel.syntheses.map(({ synthesisId }) => synthesisId), [as.synthesis.id]);
    assert.equal(afterCancel.conflicts.length, 1);
    assert.equal((await database.selectFrom("runtime_event").selectAll().where("event_type", "=", "research_completed").execute()).length, 0);
    const direction = asDirectionDatabase(database);
    const plans = Array.from({ length: 105 }, (_, i) => planResearchResultRecord(direction, workspace.id, a.request.id,
      { ...resultInput, requestKey: `bulk-${i}`, budgetUsed: 1 }, i + 2, 100));
    await binding.batch(plans.flatMap(({ mutations }) => mutations).map((query) => binding.prepare(query.sql).bind(...query.parameters)));
    const many = await repository.findRequestDetail(workspace.id, a.request.id);
    assert.equal(many?.results.length, 106);
    assert.equal(many?.results.flatMap(({ findings }) => findings).length, 106);
  } finally { await database.destroy(); await runtime.dispose(); }
});
