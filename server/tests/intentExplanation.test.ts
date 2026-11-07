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
 * 目標（Intent）の観測についてのAgentの説明（UI-M2）。説明を書くStrategistはtest内のMCP呼び出しで、実LLMの出力ではない。
 * 事実・仮説・提案の区別、根拠の解決と鮮度、前回の版、未記録と未接続の区別を検証する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const day = 86_400_000;
/** 2026-11-05T12:00:00Z */
const start = Date.parse("2026-11-05T12:00:00Z");

const setup = async (path = ":memory:") => {
  let now = start;
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => now);
  const app = await createSignedInApp(database, services);
  const createWorkspace = new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database)));
  const workspace = await createWorkspace.execute({ name: "Shop", mission: "Mission" });
  const other = await createWorkspace.execute({ name: "Other", mission: "Other" });
  const intent = await services.createIntentUseCase.execute(workspace.id, { title: "売上を月30万円へ", desiredState: "月間売上が30万円に達する" });
  const otherIntent = await services.createIntentUseCase.execute(other.id, { title: "Other", desiredState: "Other" });
  await seedWorkspaceGrant(database, workspace.id, "str", "strategist");
  await seedWorkspaceGrant(database, workspace.id, "ev", "evaluator");
  await seedWorkspaceGrant(database, other.id, "str-other", "strategist");
  return { database, services, app, workspace, other, intent, otherIntent, advance: (ms: number) => void (now += ms) };
};
type Kit = Awaited<ReturnType<typeof setup>>;

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

const source = { name: "Sales report", uri: "https://reports.example.com/sales" };
const observation = (date: string, value: number, observedAt = Date.parse(`${date}T23:00:00Z`)) => ({
  periodStart: date,
  periodEnd: date,
  status: "observed",
  value,
  source,
  observedAt,
});

/** 観測項目・観測値・Outcome・Research（Finding・Synthesis）を、公開の入口と同じuse caseで用意する。 */
const prepare = async (kit: Kit) => {
  const { app, services, workspace, intent } = kit;
  ok(await callTool(app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, key: "revenue", name: "月間売上", unit: "円", staleAfterDays: 3 }, "str"));
  const recorded = ok(
    await callTool(app, "record_intent_metric_observations", {
      workspaceId: workspace.id,
      intentId: intent.id,
      metricKey: "revenue",
      observations: [observation("2026-11-03", 100_000), observation("2026-11-04", 130_000)],
    }, "ev"),
  );
  const [before, after] = recorded.observations.map((item: any) => item.observation.id as string);
  const outcome = await services.createOutcomeUseCase.execute(workspace.id, intent.id, {
    intentVersion: 1,
    title: "再購入を増やす",
    description: "再購入導線を改善する",
    rationale: "売上の主因",
    successCriteria: [{ description: "再購入率が上がる", measurement: "再購入率" }],
  });
  const request = await services.createResearchRequestUseCase.execute(workspace.id, {
    requestKey: "r1",
    kind: "decision",
    question: "売上が増えた理由",
    scope: "11月",
    completionCondition: "根拠がある",
    budgetTotal: 100,
    originIntentId: intent.id,
  });
  const result = await services.registerResearchResultUseCase.execute(workspace.id, request.id, {
    requestKey: "res1",
    principalId: "researcher",
    runRef: "run-1",
    summary: "s",
    budgetUsed: 10,
    evidenceRefs: [{ kind: "url", uri: "https://example.com/a", retrievedAt: start }],
    findings: [{ statement: "キャンペーン期間と重なっている", confidence: "medium", observedAt: start, expiresAt: start + 2 * day, evidenceIndexes: [0] }],
    unknowns: [],
    options: [],
    risks: [],
  });
  const findingId = result.findings[0]!.id;
  const synthesis = await services.registerResearchSynthesisUseCase.execute(workspace.id, request.id, {
    requestKey: "s1",
    principalId: "researcher",
    runRef: "run-1",
    conclusion: "キャンペーンの影響が考えられる",
    findingIds: [findingId],
    risks: [],
    options: [],
    unknowns: [],
    validAsOf: start,
  });
  return { before: before!, after: after!, outcome, request, findingId, synthesis };
};

const explanationInput = (refs: Awaited<ReturnType<typeof prepare>>, overrides: object = {}) => ({
  requestKey: "exp-1",
  runRef: "run-exp-1",
  metricKey: "revenue",
  periodStart: "2026-11-03",
  periodEnd: "2026-11-04",
  relatedOutcomeIds: [refs.outcome.id],
  items: [
    { kind: "fact", statement: "売上は10万円から13万円へ増えた", basis: [{ type: "metric_observation", id: refs.before }, { type: "metric_observation", id: refs.after }] },
    { kind: "fact", statement: "調査ではキャンペーン期間と重なっていた", basis: [{ type: "finding", id: refs.findingId }] },
    { kind: "hypothesis", statement: "増加はキャンペーンの影響かもしれない", confidence: "low", verification: "終了後の売上が元の水準へ戻るか確認する", basedOn: [0, 1], basis: [{ type: "synthesis", id: refs.synthesis.id }] },
    { kind: "proposal", statement: "キャンペーン終了後の売上を観測する", basedOn: [2] },
  ],
  ...overrides,
});

test("事実・仮説・提案を根拠付きで記録し、原記録から解決して関連Outcomeと共に返す", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-intent-explanation-"));
  const path = join(directory, "compass.sqlite");
  try {
    const kit = await setup(path);
    const { workspace, intent, app } = kit;
    const refs = await prepare(kit);
    const input = explanationInput(refs);
    const recorded = ok(await callTool(app, "record_intent_explanation", { workspaceId: workspace.id, intentId: intent.id, ...input }, "str"));
    assert.equal(recorded.result, "recorded");
    assert.equal(recorded.explanation.version, 1);
    assert.equal(recorded.explanation.previousId, null);
    assert.equal(recorded.explanation.principalId, "str");
    // 応答を失った再送は重複しない。
    const again = ok(await callTool(app, "record_intent_explanation", { workspaceId: workspace.id, intentId: intent.id, ...input }, "str"));
    assert.equal(again.result, "replayed");
    assert.equal(again.explanation.id, recorded.explanation.id);
    // 同じrequestKeyで内容が違えば競合。
    const conflict = errorOf(await callTool(app, "record_intent_explanation", {
      workspaceId: workspace.id,
      intentId: intent.id,
      ...explanationInput(refs, { periodEnd: "2026-11-03" }),
    }, "str"));
    assert.equal(conflict.code, "CONFLICT");
    assert.equal(conflict.details?.reason ?? conflict.reason, "request_key_conflict");

    const read = async (target = kit) => {
      const response = await target.app.request(`/api/workspaces/${workspace.id}/intents/${intent.id}/explanations`);
      assert.equal(response.status, 200);
      return response.json();
    };
    const body = await read();
    assert.deepEqual(body.metrics.map((metric: any) => [metric.key, metric.state]), [["revenue", "observed"]]);
    assert.equal(body.explanations.length, 1);
    const [view] = body.explanations;
    assert.deepEqual(view.items.map((item: any) => item.kind), ["fact", "fact", "hypothesis", "proposal"]);
    assert.deepEqual([view.periodStart, view.periodEnd, view.metricKey], ["2026-11-03", "2026-11-04", "revenue"]);
    assert.deepEqual(view.relatedOutcomes.map((outcome: any) => outcome.title), ["再購入を増やす"]);
    // 原記録の値は保存せず、読み取り時に解決する。
    assert.equal(view.items[0].basis[1].detail.value, 130_000);
    assert.equal(view.items[1].basis[0].detail.statement, "キャンペーン期間と重なっている");
    assert.equal(view.items[2].basis[0].detail.version, 1);
    assert.equal(view.items[2].confidence, "low");
    assert.equal(view.items[2].verification, "終了後の売上が元の水準へ戻るか確認する");
    assert.equal(view.basisOutdated, false);

    // 根拠が古くなる: 観測の訂正・Findingの期限切れ・Synthesisの置換。
    ok(await callTool(app, "record_intent_metric_observations", {
      workspaceId: workspace.id,
      intentId: intent.id,
      metricKey: "revenue",
      observations: [observation("2026-11-04", 125_000, start + 1)],
    }, "ev"));
    kit.advance(3 * day);
    await kit.services.registerResearchSynthesisUseCase.execute(workspace.id, refs.request.id, {
      requestKey: "s2", principalId: "researcher", runRef: "run-2", conclusion: "v2", findingIds: [refs.findingId], risks: [], options: [], unknowns: [], validAsOf: start, supersedesId: refs.synthesis.id,
    });
    const stale = (await read()).explanations[0];
    assert.equal(stale.basisOutdated, true);
    assert.deepEqual(stale.items[0].basis.map((basis: any) => basis.state), ["current", "revised"]);
    assert.equal(stale.items[1].basis[0].state, "expired");
    assert.equal(stale.items[2].basis[0].state, "superseded");
    // 古い根拠は残すだけで、説明を書き換えたり最新値へ置き換えたりしない。
    assert.equal(stale.items[0].basis[1].detail.value, 130_000);

    // 次の版は前回を指し、前回からの変化を持つ。
    const second = ok(await callTool(app, "record_intent_explanation", {
      workspaceId: workspace.id,
      intentId: intent.id,
      ...explanationInput(refs, { requestKey: "exp-2", changeFromPrevious: "11/4の売上が訂正された" }),
    }, "str"));
    assert.equal(second.explanation.version, 2);
    assert.equal(second.explanation.previousId, recorded.explanation.id);
    const latest = (await read()).explanations;
    assert.deepEqual(latest.map((item: any) => item.version), [2, 1]);
    assert.equal(latest[0].changeFromPrevious, "11/4の売上が訂正された");

    // 再起動後も同じschemaで同じ内容が読める。
    await kit.database.destroy();
    const reopenedDatabase = createDatabase(path);
    try {
      await initializeSchema(reopenedDatabase);
      const reopened = createApplicationServices(reopenedDatabase, undefined, () => start + 3 * day);
      const listed = await reopened.listIntentExplanationsUseCase.execute(workspace.id, intent.id);
      assert.deepEqual(listed.explanations.map((item) => item.version), [2, 1]);
    } finally {
      await reopenedDatabase.destroy();
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("根拠のない事実・因果の断定・先行しない参照・範囲外の記録は拒否する", async () => {
  const kit = await setup();
  try {
    const { workspace, intent, app } = kit;
    const refs = await prepare(kit);
    const call = (input: object, principal = "str") => callTool(app, "record_intent_explanation", { workspaceId: workspace.id, intentId: intent.id, ...input }, principal);
    const validation = (input: object) => {
      const error = errorOf(input as ToolResult);
      assert.equal(error.code, "VALIDATION_ERROR");
      return JSON.stringify(error);
    };
    const base = explanationInput(refs);
    // 根拠の無い事実は事実として記録できない。
    assert.match(validation(await call({ ...base, requestKey: "k1", items: [{ kind: "fact", statement: "増えた" }] })), /basis/);
    // 仮説は確認方法と確からしさが必須で、事実を指す。
    assert.match(validation(await call({ ...base, requestKey: "k2", items: [base.items[0], { kind: "hypothesis", statement: "効いた", basedOn: [0] }] })), /confidence|verification/);
    assert.match(validation(await call({ ...base, requestKey: "k3", items: [base.items[0], { kind: "hypothesis", statement: "効いた", confidence: "high", verification: "v", basedOn: [] }] })), /basedOn/);
    // 仮説は仮説を根拠にしない。提案は先行する項目だけを指す。
    assert.match(validation(await call({ ...base, requestKey: "k4", items: [base.items[0], base.items[2], { ...base.items[2], basedOn: [1] }] })), /fact/);
    assert.match(validation(await call({ ...base, requestKey: "k5", items: [base.items[0], { kind: "proposal", statement: "x", basedOn: [2] }] })), /earlier/);
    // 事実を持たない説明は記録できない。種別に合わない根拠は拒否する。
    assert.match(validation(await call({ ...base, requestKey: "k6", items: [base.items[3]] })), /fact/);
    assert.match(validation(await call({ ...base, requestKey: "k7", items: [{ ...base.items[0], basis: [{ type: "decision", id: "x" }] }] })), /basis/);
    // 期間の逆転・未来。
    assert.match(validation(await call({ ...base, requestKey: "k8", periodStart: "2026-11-04", periodEnd: "2026-11-03" })), /periodEnd/);
    assert.match(validation(await call({ ...base, requestKey: "k9", periodStart: "2026-12-01", periodEnd: "2026-12-02" })), /started/);
    // 存在しない・別Workspaceの記録、別Intentのoutcomeは参照できない。
    assert.match(validation(await call({ ...base, requestKey: "k10", items: [{ ...base.items[0], basis: [{ type: "metric_observation", id: "missing" }] }] })), /metric_observation/);
    assert.match(validation(await call({ ...base, requestKey: "k11", relatedOutcomeIds: ["missing"] })), /outcome/);
    // 未定義の観測項目・他Workspace・認可。
    assert.equal(errorOf(await call({ ...base, requestKey: "k12", metricKey: "nope" })).code, "NOT_FOUND");
    assert.equal(errorOf(await callTool(app, "record_intent_explanation", { workspaceId: kit.other.id, intentId: intent.id, ...base, requestKey: "k13" }, "str-other")).code, "NOT_FOUND");
    assert.equal(errorOf(await call({ ...base, requestKey: "k14" }, "ev")).code, "FORBIDDEN");
    assert.equal(errorOf(await call({ ...base, requestKey: "k15" }, "nobody")).code, "FORBIDDEN");
    // 何も保存されていない。
    const listed = ok(await callTool(app, "list_intent_explanations", { workspaceId: workspace.id, intentId: intent.id }));
    assert.deepEqual(listed.explanations, []);
    // 初回の「前回からの変化」は保存しない。
    const first = ok(await call({ ...base, requestKey: "k16", changeFromPrevious: "前回は無い" }));
    assert.equal(first.explanation.changeFromPrevious, null);
    // archive後は記録できない。
    await archiveTestWorkspace(kit.database, workspace.id);
    assert.equal(errorOf(await call({ ...base, requestKey: "k17" })).code, "CONFLICT");
  } finally {
    await kit.database.destroy();
  }
});

test("説明が無い・観測が未接続・取得失敗の状態を、生成した説明で埋めずに区別して返す", async () => {
  const kit = await setup();
  try {
    const { workspace, intent, app } = kit;
    const read = async () => (await (await app.request(`/api/workspaces/${workspace.id}/intents/${intent.id}/explanations`)).json()) as Record<string, any>;
    // 観測項目も説明も無い。
    assert.deepEqual(await read(), { intentId: intent.id, observedAt: start, metrics: [], explanations: [] });
    // 観測項目だけ定義されて未計測。
    ok(await callTool(app, "define_intent_metric", { workspaceId: workspace.id, intentId: intent.id, key: "revenue", name: "月間売上", unit: "円", staleAfterDays: 3 }, "str"));
    let body = await read();
    assert.deepEqual(body.metrics.map((metric: any) => metric.state), ["unmeasured"]);
    assert.deepEqual(body.explanations, []);
    // 取得失敗は失敗として残り、説明の記録は観測状態を変えない。
    ok(await callTool(app, "record_intent_metric_observations", {
      workspaceId: workspace.id,
      intentId: intent.id,
      metricKey: "revenue",
      observations: [{ periodStart: "2026-11-04", periodEnd: "2026-11-04", status: "failed", failureReason: "API timeout", source, observedAt: start - 1000 }],
    }, "ev"));
    body = await read();
    assert.deepEqual(body.metrics.map((metric: any) => [metric.state, metric.lastObservedPeriodEnd]), [["failed", null]]);
    // 別Workspaceのintentは読めない。
    const foreign = await app.request(`/api/workspaces/${kit.other.id}/intents/${intent.id}/explanations`);
    assert.equal(foreign.status, 404);
    // 古い観測。説明の有無とは独立に、観測の鮮度が状態に出る。
    kit.advance(10 * day);
    ok(await callTool(app, "record_intent_metric_observations", {
      workspaceId: workspace.id, intentId: intent.id, metricKey: "revenue", observations: [observation("2026-11-05", 90_000, start + 9 * day)],
    }, "ev"));
    body = await read();
    assert.deepEqual(body.metrics.map((metric: any) => [metric.state, metric.lastObservedPeriodEnd]), [["stale", "2026-11-05"]]);
    assert.deepEqual(body.explanations, []);
  } finally {
    await kit.database.destroy();
  }
});
