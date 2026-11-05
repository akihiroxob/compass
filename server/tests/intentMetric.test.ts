import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import type { createApp } from "../src/bootstrap/app.ts";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { archiveTestWorkspace, createSignedInApp, seedWorkspaceGrant } from "./support/humanSession.ts";

/**
 * Intentの観測項目と時系列（UI-M1）。Strategist・Evaluatorとして振る舞うのはtest内のMCP呼び出しで、計測基盤との接続ではない。
 * 時刻は固定のclockで、鮮度（stale）の判定をUTCの暦日で確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const day = 86_400_000;
/** 2026-11-05T12:00:00Z */
const now = Date.parse("2026-11-05T12:00:00Z");

const setup = async (path = ":memory:", clock = () => now) => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, clock);
  const app = await createSignedInApp(database, services);
  const createWorkspace = new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database)));
  const workspace = await createWorkspace.execute({ name: "Shop", mission: "Mission" });
  const other = await createWorkspace.execute({ name: "Other", mission: "Other" });
  // 説明文に数字を含めても、目標値は明示した値だけになることを確認する。
  const intent = await services.createIntentUseCase.execute(workspace.id, {
    title: "売上を月30万円へ",
    desiredState: "月間売上が30万円に達し、50%の利用者が再購入する",
  });
  const otherIntent = await services.createIntentUseCase.execute(other.id, { title: "Other", desiredState: "Other" });
  await seedWorkspaceGrant(database, workspace.id, "str", "strategist");
  await seedWorkspaceGrant(database, workspace.id, "ev", "evaluator");
  await seedWorkspaceGrant(database, other.id, "ev-other", "evaluator");
  return { database, services, app, workspace, other, intent, otherIntent };
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

const revenueMetric = { key: "monthly_revenue", name: "月間売上", unit: "円", targetValue: 300_000, staleAfterDays: 2 };
const source = { name: "Sales report", uri: "https://reports.example.com/sales" };
const daily = (date: string, value: number, extra: object = {}) => ({
  periodStart: date,
  periodEnd: date,
  status: "observed",
  value,
  source,
  observedAt: Date.parse(`${date}T23:00:00Z`),
  ...extra,
});

test("a Metric and its daily series are recorded once, revised on change and persisted with target, period, unit, source and revision", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-intent-metric-"));
  const path = join(directory, "compass.sqlite");
  try {
    const kit = await setup(path);
    const { workspace, intent } = kit;
    const defined = ok(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, ...revenueMetric }, "str"));
    assert.equal(defined.result, "created");
    assert.equal(defined.metric.revision, 1);
    // 同じ定義の再送は変更しない。
    const again = ok(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, ...revenueMetric }, "str"));
    assert.equal(again.result, "unchanged");
    assert.equal(again.metric.id, defined.metric.id);

    const observations = [daily("2026-11-02", 120_000), daily("2026-11-03", 0), daily("2026-11-04", 150_000)];
    const args = { workspaceId: workspace.id, intentId: intent.id, metricKey: "monthly_revenue", observations };
    const first = ok(await callTool(kit.app, "record_intent_metric_observations", args, "ev"));
    assert.deepEqual(first.observations.map((item: any) => [item.kind, item.observation.revision]), [["created", 1], ["created", 1], ["created", 1]]);
    // 応答を失った再送は重複しない。
    const resent = ok(await callTool(kit.app, "record_intent_metric_observations", args, "ev"));
    assert.deepEqual(resent.observations.map((item: any) => item.kind), ["unchanged", "unchanged", "unchanged"]);
    assert.deepEqual(resent.observations.map((item: any) => item.observation.id), first.observations.map((item: any) => item.observation.id));
    // 同じ対象期間の訂正は次の版として追記し、過去の版を書き換えない。
    const corrected = ok(await callTool(kit.app, "record_intent_metric_observations", {
      ...args,
      observations: [daily("2026-11-04", 155_000, { observedAt: Date.parse("2026-11-05T01:00:00Z") })],
    }, "ev"));
    assert.equal(corrected.observations[0].kind, "revised");
    assert.equal(corrected.observations[0].observation.revision, 2);
    // 訂正を挟んだ旧要求の遅延再送は版を増やさず、現在値も戻さない。
    const late = ok(await callTool(kit.app, "record_intent_metric_observations", args, "ev"));
    assert.deepEqual(late.observations.map((item: any) => item.kind), ["unchanged", "unchanged", "unchanged"]);
    assert.equal(late.observations[2].observation.revision, 2);
    assert.equal(late.observations[2].observation.value, 155_000);
    // Dateで表せない観測時刻は例外ではなく構造化した検証エラーにする。
    const outOfRange = errorOf(await callTool(kit.app, "record_intent_metric_observations", {
      ...args,
      observations: [daily("2026-11-04", 1, { observedAt: 8_640_000_000_000_001 })],
    }, "ev"));
    assert.equal(outOfRange.code, "VALIDATION_ERROR");
    assert.equal((await kit.database.selectFrom("intent_metric_observation").select("id").execute()).length, 4);
    await kit.database.destroy();

    // 同じDB fileを開き直しても、目標・期間・単位・出所・版がそのまま読める。
    const reopened = await setup(path);
    try {
      const listed = ok(await callTool(reopened.app, "list_intent_metrics", { workspaceId: workspace.id, intentId: intent.id }, "ev"));
      assert.equal(listed.metrics.length, 1);
      const [metric] = listed.metrics;
      assert.equal(metric.key, "monthly_revenue");
      assert.equal(metric.unit, "円");
      assert.equal(metric.targetValue, 300_000);
      assert.deepEqual([metric.series.from, metric.series.to], ["2026-10-07", "2026-11-05"]);
      assert.deepEqual(
        metric.series.points.map((point: any) => [point.periodStart, point.periodEnd, point.value, point.revision, point.source.name, point.source.uri, point.principalId]),
        [
          ["2026-11-02", "2026-11-02", 120_000, 1, "Sales report", "https://reports.example.com/sales", "ev"],
          ["2026-11-03", "2026-11-03", 0, 1, "Sales report", "https://reports.example.com/sales", "ev"],
          ["2026-11-04", "2026-11-04", 155_000, 2, "Sales report", "https://reports.example.com/sales", "ev"],
        ],
      );
      assert.equal(metric.current.state, "observed");
      assert.equal(metric.current.latest.value, 155_000);

      // Human（Workspace Membership）も同じ契約をWeb APIで読む。
      const response = await reopened.app.request(`/api/workspaces/${workspace.id}/intents/${intent.id}/metrics?from=2026-11-03&to=2026-11-03`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.metrics[0].series.points.map((point: any) => point.value), [0]);
      assert.equal(body.metrics[0].current.state, "observed");
    } finally {
      await reopened.database.destroy();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("other Workspaces, wrong Roles, invalid values, periods and times, inactive Intents and archived Workspaces are rejected", async () => {
  const kit = await setup();
  const { workspace, other, intent, otherIntent, database } = kit;
  try {
    ok(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, ...revenueMetric }, "str"));
    const record = (args: object, principal = "ev", intentId = intent.id, workspaceId = workspace.id) =>
      callTool(kit.app, "record_intent_metric_observations", { workspaceId, intentId, metricKey: "monthly_revenue", ...args }, principal);

    // 別WorkspaceのIntent・Grant、別Role、未定義の項目。
    assert.equal(errorOf(await record({ observations: [daily("2026-11-04", 1)] }, "ev", otherIntent.id)).code, "NOT_FOUND");
    assert.equal(errorOf(await record({ observations: [daily("2026-11-04", 1)] }, "ev-other")).code, "FORBIDDEN");
    assert.equal(errorOf(await record({ observations: [daily("2026-11-04", 1)] }, "ev-other", intent.id, other.id)).code, "NOT_FOUND");
    assert.equal(errorOf(await record({ observations: [daily("2026-11-04", 1)] }, "str")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(kit.app, "record_intent_metric_observations", {
      workspaceId: workspace.id, intentId: intent.id, metricKey: "monthly_revenue", observations: [daily("2026-11-04", 1)],
    })).code, "UNAUTHENTICATED");
    assert.equal(errorOf(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, ...revenueMetric }, "ev")).code, "FORBIDDEN");
    assert.equal(errorOf(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: otherIntent.id, ...revenueMetric }, "str")).code, "NOT_FOUND");
    assert.equal(errorOf(await callTool(kit.app, "record_intent_metric_observations", {
      workspaceId: workspace.id, intentId: intent.id, metricKey: "unknown", observations: [daily("2026-11-04", 1)],
    }, "ev")).code, "NOT_FOUND");
    assert.equal(errorOf(await callTool(kit.app, "list_intent_metrics", { workspaceId: workspace.id, intentId: otherIntent.id }, "ev")).code, "NOT_FOUND");

    // 不正な値・期間・時刻。
    const invalid = async (observation: object, path: string) => {
      const error = errorOf(await record({ observations: [observation] }));
      assert.equal(error.code, "VALIDATION_ERROR", JSON.stringify(error));
      assert.ok(JSON.stringify(error).includes(path), `${path}: ${JSON.stringify(error)}`);
    };
    await invalid({ ...daily("2026-11-04", 1), value: null }, "value");
    await invalid({ ...daily("2026-11-04", 1), status: "failed", failureReason: "timeout" }, "value");
    await invalid({ ...daily("2026-11-04", 1), status: "failed", value: null }, "failureReason");
    await invalid({ ...daily("2026-11-04", 1), status: "estimated" }, "status");
    await invalid({ ...daily("2026-11-04", 1), periodStart: "2026-02-30", periodEnd: "2026-02-30" }, "periodStart");
    await invalid({ ...daily("2026-11-04", 1), periodEnd: "2026-11-03" }, "periodEnd");
    await invalid({ ...daily("2026-11-04", 1), observedAt: now + day }, "observedAt");
    await invalid({ ...daily("2026-11-04", 1), observedAt: Date.parse("2026-11-01T00:00:00Z") }, "periodStart");
    await invalid({ ...daily("2026-11-04", 1), source: { name: "Report", uri: "https://user:secret@example.com/" } }, "source.uri");
    await invalid({ ...daily("2026-11-04", 1), source: { name: "Report", uri: "file:///tmp/report" } }, "source.uri");
    const duplicate = errorOf(await record({ observations: [daily("2026-11-04", 1), daily("2026-11-04", 2)] }));
    assert.equal(duplicate.code, "VALIDATION_ERROR");
    const invalidMetric = errorOf(await callTool(kit.app, "define_intent_metric", {
      workspaceId: workspace.id, intentId: intent.id, ...revenueMetric, key: "Bad Key", staleAfterDays: 0,
    }, "str"));
    assert.equal(invalidMetric.code, "VALIDATION_ERROR");
    assert.deepEqual(await database.selectFrom("intent_metric_observation").select("id").execute(), []);

    // 観測値がある項目の単位は変えられない。名前・目標値は版を上げて変更できる。
    ok(await record({ observations: [daily("2026-11-04", 1)] }));
    const locked = errorOf(await callTool(kit.app, "define_intent_metric", {
      workspaceId: workspace.id, intentId: intent.id, ...revenueMetric, unit: "USD",
    }, "str"));
    assert.equal(locked.code, "CONFLICT");
    assert.equal(locked.details?.reason ?? locked.reason, "unit_locked");
    const updated = ok(await callTool(kit.app, "define_intent_metric", {
      workspaceId: workspace.id, intentId: intent.id, ...revenueMetric, targetValue: 350_000,
    }, "str"));
    assert.deepEqual([updated.result, updated.metric.revision, updated.metric.targetValue], ["updated", 2, 350_000]);

    // activeでないIntent、archivedのWorkspace。
    const abandoned = await kit.services.createIntentUseCase.execute(workspace.id, { title: "Dropped", desiredState: "Dropped" });
    ok(await callTool(kit.app, "define_intent_metric", { workspaceId: workspace.id, intentId: abandoned.id, ...revenueMetric }, "str"));
    await kit.services.abandonIntentUseCase.execute(workspace.id, abandoned.id, { reason: "Stop" });
    const inactive = errorOf(await record({ observations: [daily("2026-11-04", 1)] }, "ev", abandoned.id));
    assert.equal(inactive.code, "CONFLICT");
    await archiveTestWorkspace(database, workspace.id);
    assert.equal(errorOf(await record({ observations: [daily("2026-11-03", 1)] })).code, "CONFLICT");
  } finally {
    await database.destroy();
  }
});

test("no Metric, no observation, a stale value, a failed fetch and a zero value stay distinguishable without filling gaps", async () => {
  let clock = now;
  const kit = await setup(":memory:", () => clock);
  const { workspace, intent, database } = kit;
  try {
    const list = async () => ok(await callTool(kit.app, "list_intent_metrics", { workspaceId: workspace.id, intentId: intent.id }, "ev"));
    // 観測項目が未定義。
    assert.deepEqual((await list()).metrics, []);

    // 目標値を明示しない項目は、Intentの説明文に数字があってもnull。
    const defined = ok(await callTool(kit.app, "define_intent_metric", {
      workspaceId: workspace.id, intentId: intent.id, key: "repeat_rate", name: "再購入率", unit: "%", staleAfterDays: 2,
    }, "str"));
    assert.equal(defined.metric.targetValue, null);
    let [metric] = (await list()).metrics;
    assert.equal(metric.current.state, "unmeasured");
    assert.equal(metric.current.latest, null);
    assert.deepEqual(metric.series.points, []);

    const record = (observations: object[]) =>
      callTool(kit.app, "record_intent_metric_observations", { workspaceId: workspace.id, intentId: intent.id, metricKey: "repeat_rate", observations }, "ev");
    // 11/01と11/04だけ観測し、間の日を埋めない。11/04はゼロ。
    ok(await record([daily("2026-11-01", 12.5), daily("2026-11-04", 0)]));
    [metric] = (await list()).metrics;
    assert.equal(metric.current.state, "observed");
    assert.equal(metric.current.latest.value, 0);
    assert.deepEqual(metric.series.points.map((point: any) => [point.periodStart, point.value]), [["2026-11-01", 12.5], ["2026-11-04", 0]]);

    // 期限（2日）を過ぎると、値は残したまま古い観測になる。
    clock = Date.parse("2026-11-07T12:00:00Z");
    [metric] = (await list()).metrics;
    assert.equal(metric.current.state, "stale");
    assert.equal(metric.current.lastObserved.value, 0);

    // 次の日の取得失敗は値なしで残り、最後に取得できた値と区別される。
    ok(await record([{ periodStart: "2026-11-06", periodEnd: "2026-11-06", status: "failed", failureReason: "Report API timed out", source: { name: "Sales report" }, observedAt: clock }]));
    [metric] = (await list()).metrics;
    assert.equal(metric.current.state, "failed");
    assert.equal(metric.current.latest.value, null);
    assert.equal(metric.current.latest.failureReason, "Report API timed out");
    assert.equal(metric.current.lastObserved.periodStart, "2026-11-04");
    assert.deepEqual(
      metric.series.points.map((point: any) => [point.periodStart, point.status, point.value]),
      [["2026-11-01", "observed", 12.5], ["2026-11-04", "observed", 0], ["2026-11-06", "failed", null]],
    );
    // 範囲外・不正な範囲。
    const narrow = ok(await callTool(kit.app, "list_intent_metrics", { workspaceId: workspace.id, intentId: intent.id, from: "2026-11-02", to: "2026-11-03" }, "ev"));
    assert.deepEqual(narrow.metrics[0].series.points, []);
    assert.equal(narrow.metrics[0].current.state, "failed");
    assert.equal(errorOf(await callTool(kit.app, "list_intent_metrics", { workspaceId: workspace.id, intentId: intent.id, from: "2026-11-05", to: "2026-11-01" }, "ev")).code, "VALIDATION_ERROR");
    const response = await kit.app.request(`/api/workspaces/${workspace.id}/intents/${intent.id}/metrics?from=2024-01-01&to=2026-11-07`);
    assert.equal(response.status, 400);
  } finally {
    await database.destroy();
  }
});
