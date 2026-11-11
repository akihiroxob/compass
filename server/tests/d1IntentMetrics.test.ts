import assert from "node:assert/strict";
import test from "node:test";
import type { IntentMetricObservationInput } from "@compass/direction";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asDirectionDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1IntentMetricRepository } from "../src/infrastructure/repository/d1/D1IntentMetricRepository.ts";

const definition = { key: "revenue", name: "Revenue", unit: "JPY", targetValue: 300_000, staleAfterDays: 2 };
const point = (date: string, value: number): IntentMetricObservationInput => ({ periodStart: date, periodEnd: date,
  status: "observed", value, failureReason: null, source: { name: "Report", uri: null }, observedAt: 100 });
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const workspace = await organization.workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] });
    await context.database.insertInto("intent").values({ id: "intent", workspace_id: workspace.id, title: "Intent", desired_state: "Goal",
      status: "active", version: 1, meaning_version: 1, created_at: 1, updated_at: 1 }).execute();
    const repository = new D1IntentMetricRepository(asDirectionDatabase(context.database), context.binding);
    return { ...context, ...organization, workspace, repository };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 Metric definitions converge, retain identity and lock units once an observation exists", async () => {
  const { runtime, binding, database, workspace, repository, workspaceRepository } = await setup();
  try {
    const concurrent = await Promise.all([repository.define(workspace.id, "intent", "strategist", definition, 1),
      repository.define(workspace.id, "intent", "strategist", definition, 1)]);
    assert.deepEqual(concurrent.map(({ kind }) => kind).sort(), ["created", "unchanged"]);
    const first = concurrent[0]!;
    assert.ok("metric" in first);
    const edited = await repository.define(workspace.id, "intent", "strategist", { ...definition, unit: "USD" }, 2);
    assert.ok(edited.kind === "updated");
    assert.equal(edited.metric.id, first.metric.id);
    assert.equal(edited.metric.revision, 2);
    await repository.recordObservations(workspace.id, "intent", definition.key, "evaluator", [point("2026-11-01", 0)], 3);
    assert.deepEqual(await repository.define(workspace.id, "intent", "strategist", definition, 4), { kind: "unit_locked", unit: "USD" });
    assert.deepEqual(await repository.define("other", "intent", "strategist", definition, 4), { kind: "intent_not_found" });
    assert.equal(await repository.listByIntent("other", "intent", { from: "2026-11-01", to: "2026-11-30" }), null);
    await repository.define(workspace.id, "intent", "strategist", { ...definition, key: "racing" }, 5);
    let inject = true;
    const racingBinding = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (inject) {
          inject = false;
          await repository.recordObservations(workspace.id, "intent", "racing", "evaluator", [point("2026-11-01", 10)], 6);
        }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    const racing = new D1IntentMetricRepository(asDirectionDatabase(database), racingBinding);
    assert.deepEqual(await racing.define(workspace.id, "intent", "strategist", { ...definition, key: "racing", unit: "USD" }, 7), { kind: "unit_locked", unit: "JPY" });
    await database.updateTable("intent").set({ status: "achieved" }).where("id", "=", "intent").execute();
    assert.deepEqual(await repository.define(workspace.id, "intent", "strategist", definition, 5), { kind: "intent_not_active", status: "achieved" });
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.define(workspace.id, "intent", "strategist", definition, 6), { kind: "workspace_archived" });
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 observations serialize revisions, ignore delayed retries and save multiple periods atomically", async () => {
  const { runtime, binding, database, workspace, repository } = await setup();
  try {
    await repository.define(workspace.id, "intent", "strategist", definition, 1);
    const initial = point("2026-11-01", 100);
    const record = (observations: IntentMetricObservationInput[]) => repository.recordObservations(workspace.id, "intent", definition.key, "evaluator", observations, 2);
    const concurrent = await Promise.all([record([initial]), record([initial])]);
    assert.ok(concurrent.every((result) => result.kind === "recorded"));
    assert.deepEqual(concurrent.map((result) => result.kind === "recorded" ? result.observations[0]!.kind : "error").sort(), ["created", "unchanged"]);
    const revised = await record([{ ...initial, value: 120, observedAt: 200 }]);
    assert.ok(revised.kind === "recorded");
    assert.equal(revised.observations[0]?.observation.revision, 2);
    const delayed = await record([initial]);
    assert.ok(delayed.kind === "recorded");
    assert.equal(delayed.observations[0]?.kind, "unchanged");
    assert.equal(delayed.observations[0]?.observation.value, 120);
    const next = point("2026-11-02", 0);
    const failed = { ...point("2026-11-03", 1), status: "failed" as const, value: null, failureReason: "Unavailable" };
    await binding.prepare("CREATE TRIGGER reject_period BEFORE INSERT ON intent_metric_observation WHEN NEW.period_start = '2026-11-03' BEGIN SELECT RAISE(ABORT, 'period failure'); END;").run();
    await assert.rejects(record([next, failed]), /period failure/);
    assert.equal((await database.selectFrom("intent_metric_observation").selectAll().execute()).length, 2);
    await binding.prepare("DROP TRIGGER reject_period").run();
    await record([next, failed]);
    const series = (await repository.listByIntent(workspace.id, "intent", { from: "2026-11-02", to: "2026-11-03" }))![0]!;
    assert.equal(series.latest?.failureReason, "Unavailable");
    assert.equal(series.lastObserved?.value, 0);
    assert.deepEqual(series.series.map(({ value }) => value), [0, null]);
    assert.equal((await repository.listByIntent(workspace.id, "intent", { from: "2020-01-01", to: "2020-01-02" }))![0]?.series.length, 0);
    const competing = await Promise.all([record([{ ...initial, value: 200, observedAt: 300 }]), record([{ ...initial, value: 300, observedAt: 400 }])]);
    assert.ok(competing.every((result) => result.kind === "recorded"));
    assert.deepEqual((await database.selectFrom("intent_metric_observation").select("revision").where("period_start", "=", initial.periodStart).orderBy("revision").execute()).map(({ revision }) => revision), [1, 2, 3, 4]);
  } finally { await database.destroy(); await runtime.dispose(); }
});
