import assert from "node:assert/strict";
import test from "node:test";
import { planIntentExplanationRecord, type RecordIntentExplanationInput } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1IntentMetricRepository } from "../src/infrastructure/repository/d1/D1IntentMetricRepository.ts";
import { D1IntentExplanationRepository } from "../src/infrastructure/repository/d1/D1IntentExplanationRepository.ts";

const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    const direction = asDirectionDatabase(context.database);
    const metrics = new D1IntentMetricRepository(direction, context.binding);
    const metric = await metrics.define(workspace.id, "intent", "strategist", { key: "revenue", name: "Revenue", unit: "JPY", targetValue: null, staleAfterDays: 2 }, 100);
    assert.ok(metric.kind === "created");
    const recorded = await metrics.recordObservations(workspace.id, "intent", "revenue", "evaluator", [{ periodStart: "2026-11-01", periodEnd: "2026-11-01",
      status: "observed", value: 100, failureReason: null, source: { name: "Report", uri: null }, observedAt: 100 }], 100);
    assert.ok(recorded.kind === "recorded");
    const input: RecordIntentExplanationInput = { requestKey: "explanation", runRef: "run", metricKey: "revenue", periodStart: "2026-11-01", periodEnd: "2026-11-01",
      changeFromPrevious: "Changed", relatedOutcomeIds: [], items: [{ kind: "fact", statement: "Observed value", confidence: null, verification: null,
        basedOn: [], basis: [{ type: "metric_observation", id: recorded.observations[0]!.observation.id }] }] };
    return { ...context, ...organization, workspace, input, metric: metric.metric,
      repository: new D1IntentExplanationRepository(direction, context.binding) };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 explanations save children atomically, converge on retries and serialize the previous-version chain", async () => {
  const { runtime, binding, database, workspace, input, repository, workspaceRepository } = await setup();
  try {
    await binding.prepare("CREATE TRIGGER reject_explanation_basis BEFORE INSERT ON intent_explanation_basis BEGIN SELECT RAISE(ABORT, 'basis failure'); END;").run();
    await assert.rejects(repository.record(workspace.id, "intent", "strategist", input, 100), /basis failure/);
    assert.equal((await database.selectFrom("intent_explanation").selectAll().execute()).length, 0);
    assert.equal((await database.selectFrom("intent_explanation_item").selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_explanation_basis").run();
    const replies = await Promise.all([repository.record(workspace.id, "intent", "strategist", input, 100), repository.record(workspace.id, "intent", "strategist", input, 100)]);
    assert.deepEqual(replies.map(({ kind }) => kind).sort(), ["recorded", "replayed"]);
    const first = replies[0]!;
    assert.ok("explanation" in first);
    assert.equal(first.explanation.changeFromPrevious, null);
    const edits = await Promise.all([repository.record(workspace.id, "intent", "strategist", { ...input, requestKey: "second" }, 101),
      repository.record(workspace.id, "intent", "strategist", { ...input, requestKey: "third" }, 101)]);
    assert.ok(edits.every(({ kind }) => kind === "recorded"));
    const history = await repository.listByIntent(workspace.id, "intent", 101);
    assert.deepEqual(history?.map(({ version }) => version), [3, 2, 1]);
    assert.equal(history?.[0]?.previousId, history?.[1]?.id);
    assert.equal(history?.[1]?.previousId, first.explanation.id);
    assert.equal(history?.[0]?.changeFromPrevious, "Changed");
    assert.deepEqual(await repository.record(workspace.id, "intent", "strategist", { ...input, runRef: "changed" }, 102), { kind: "key_conflict", requestKey: input.requestKey });
    assert.deepEqual(await repository.record(workspace.id, "missing", "strategist", { ...input, requestKey: "missing" }, 102), { kind: "intent_not_found" });
    assert.deepEqual(await repository.record(workspace.id, "intent", "strategist", { ...input, requestKey: "missing", metricKey: "missing" }, 102), { kind: "metric_not_found" });
    const invalid = await repository.record(workspace.id, "intent", "strategist", { ...input, requestKey: "invalid", relatedOutcomeIds: ["missing"],
      items: [{ ...input.items[0]!, basis: [{ type: "metric_observation", id: "missing" }] }] }, 102);
    assert.ok(invalid.kind === "invalid_reference");
    assert.deepEqual(invalid.references.map(({ path }) => path), ["items[0].basis[0]", "relatedOutcomeIds[0]"]);
    assert.equal(await repository.listByIntent("other", "intent", 102), null);
    await database.updateTable("intent").set({ status: "achieved" }).where("id", "=", "intent").execute();
    assert.equal((await repository.record(workspace.id, "intent", "strategist", input, 102)).kind, "replayed");
    assert.deepEqual(await repository.record(workspace.id, "intent", "strategist", { ...input, requestKey: "inactive" }, 102), { kind: "intent_not_active", status: "achieved" });
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.record(workspace.id, "intent", "strategist", input, 103), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 explanation reads resolve over 100 distinct references and keep the newest 50 versions", async () => {
  const { runtime, binding, database, workspace, input, metric, repository } = await setup();
  try {
    const ids = [input.items[0]!.basis[0]!.id];
    const statements = [];
    for (let i = 1; i < 105; i++) {
      const id = `observation-${i}`; ids.push(id);
      const query = database.insertInto("intent_metric_observation").values({ id, metric_id: metric.id, period_start: "2026-11-01", period_end: "2026-11-01",
        revision: i + 1, status: "observed", value: i, failure_reason: null, source_name: "Report", source_uri: null, observed_at: 100,
        principal_id: "evaluator", recorded_at: 100 }).compile();
      statements.push(binding.prepare(query.sql).bind(...query.parameters));
    }
    await binding.batch(statements);
    const items = Array.from({ length: 6 }, (_, i) => ({ ...input.items[0]!, statement: `Fact ${i}`,
      basis: ids.slice(i * 20, (i + 1) * 20).map((id) => ({ type: "metric_observation" as const, id })) }));
    const created = await repository.record(workspace.id, "intent", "strategist", { ...input, items }, 100);
    assert.ok(created.kind === "recorded");
    const views = await repository.listByIntent(workspace.id, "intent", 100);
    const basis = views![0]!.items.flatMap(({ basis }) => basis);
    assert.equal(basis.length, 105);
    assert.equal(basis.filter(({ state }) => state === "revised").length, 104);
    assert.equal(basis[104]?.state, "current");
    assert.equal(views?.[0]?.basisOutdated, true);
    let previous = { id: created.explanation.id, version: created.explanation.version };
    const direction = asDirectionDatabase(database);
    const mutations = [];
    for (let i = 0; i < 51; i++) {
      const plan = planIntentExplanationRecord(direction, workspace.id, "intent", "strategist", { ...input, requestKey: `bulk-${i}` }, 101 + i, previous);
      mutations.push(...plan.mutations); previous = { id: plan.row.id, version: plan.row.version };
    }
    await binding.batch(mutations.map((query) => binding.prepare(query.sql).bind(...query.parameters)));
    const history = await repository.listByIntent(workspace.id, "intent", 200);
    assert.equal(history?.length, 50);
    assert.equal(history?.[0]?.version, 52);
    assert.equal(history?.[49]?.version, 3);
  } finally { await database.destroy(); await runtime.dispose(); }
});
