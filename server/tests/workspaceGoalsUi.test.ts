import assert from "node:assert/strict";
import test from "node:test";
import { chartGeometry, changeFromEarlier, dailyPoints, formatDelta, metricHeadline, trendSummary, trendWindow, type IntentMetric, type MetricObservation } from "../src/web/features/intent/metric.ts";
import { summarizeWaiting, summarizeWorkspaceProblems, waitingCountPath, waitingCountText } from "../src/web/features/workspace/workspaceComparison.ts";
import { parseShellLocation } from "../src/web/features/workspace/workspace.ts";
import { workspaceIntentPath } from "../src/web/paths.ts";

const observation = (date: string, value: number | null, overrides: Partial<MetricObservation> = {}): MetricObservation => ({
  id: `o-${date}`, metricId: "m1", periodStart: date, periodEnd: date, revision: 1, status: value === null ? "failed" : "observed", value,
  failureReason: value === null ? "接続失敗" : null, source: { name: "計測基盤", uri: null }, observedAt: 0, ...overrides,
});
const metric = (points: MetricObservation[], state: IntentMetric["current"]["state"], overrides: Partial<IntentMetric> = {}): IntentMetric => {
  const latest = points.at(-1) ?? null;
  const lastObserved = [...points].reverse().find((point) => point.status === "observed") ?? null;
  return { id: "m1", key: "revenue", name: "月間売上", unit: "円", targetValue: 300000, staleAfterDays: 3, current: { state, latest, lastObserved }, series: { from: "2026-10-10", to: "2026-11-08", points }, ...overrides };
};

test("7日／30日の範囲は末日を含む暦日で数える", () => {
  assert.deepEqual(trendWindow("2026-11-08", 7), { from: "2026-11-02", to: "2026-11-08" });
  assert.deepEqual(trendWindow("2026-11-08", 30), { from: "2026-10-10", to: "2026-11-08" });
});

test("日次の観測だけを推移に使い、複数日の観測は件数だけ数えて按分しない", () => {
  const points = [observation("2026-11-06", 100), observation("2026-11-07", 120), observation("2026-11-05", 90, { periodStart: "2026-11-01" })];
  const { points: daily, excluded } = dailyPoints(metric(points, "observed"), trendWindow("2026-11-08", 7));
  assert.deepEqual(daily.map(({ date, value }) => [date, value]), [["2026-11-06", 100], ["2026-11-07", 120]]);
  assert.equal(excluded, 1);
});

test("範囲外の観測は含めない", () => {
  const { points } = dailyPoints(metric([observation("2026-10-20", 10), observation("2026-11-07", 20)], "observed"), trendWindow("2026-11-08", 7));
  assert.deepEqual(points.map(({ date }) => date), ["2026-11-07"]);
});

test("折れ線は連続する観測日だけを結び、欠けた日・取得失敗の日をまたいで補間しない", () => {
  const points = dailyPoints(metric([observation("2026-11-02", 10), observation("2026-11-03", 20), observation("2026-11-05", 30), observation("2026-11-06", null), observation("2026-11-07", 40)], "observed"), trendWindow("2026-11-08", 7)).points;
  const geometry = chartGeometry(points, trendWindow("2026-11-08", 7), null, { width: 600, height: 100 });
  assert.deepEqual(geometry.segments.map((segment) => segment.points.length), [2, 1, 1]);
  const failed = geometry.dots.find((dot) => dot.date === "2026-11-06");
  assert.equal(failed?.y, null);
  assert.equal(failed?.failed, true);
  assert.equal(geometry.min, 0);
  assert.equal(geometry.max, 40);
});

test("目標値があれば縦軸に含め、観測が無くても0で描かない", () => {
  const empty = chartGeometry([], trendWindow("2026-11-08", 7), 300000, { width: 600, height: 100 });
  assert.equal(empty.max, 300000);
  assert.equal(empty.segments.length, 0);
  assert.equal(empty.dots.length, 0);
});

test("7日前との差は両方が日次の観測値のときだけ出し、片方が無い・取得失敗なら出さない", () => {
  const ok = metric([observation("2026-11-01", 100), observation("2026-11-08", 160)], "observed");
  assert.deepEqual(changeFromEarlier(ok, 7), { from: "2026-11-01", delta: 60, earlier: 100, latest: 160 });
  assert.equal(changeFromEarlier(metric([observation("2026-11-08", 160)], "observed"), 7), null);
  assert.equal(changeFromEarlier(metric([observation("2026-11-01", null), observation("2026-11-08", 160)], "observed"), 7), null);
  assert.equal(formatDelta(60, "円"), "+60円");
  assert.equal(formatDelta(-1500, "人"), "-1,500人");
  assert.equal(formatDelta(0, "%"), "±0%");
});

test("見出しは未計測・取得失敗・古い観測・観測ありを区別し、失敗を現在値にしない", () => {
  assert.deepEqual(metricHeadline(metric([], "unmeasured")), { kind: "none", reason: "unmeasured" });
  const failed = metricHeadline(metric([observation("2026-11-07", 100), observation("2026-11-08", null)], "failed"));
  assert.deepEqual(failed, { kind: "failed", reason: "接続失敗", period: "2026-11-08", lastValue: { value: 100, period: "2026-11-07" } });
  assert.deepEqual(metricHeadline(metric([observation("2026-11-01", 100)], "stale")), { kind: "value", value: 100, period: "2026-11-01", stale: true });
  assert.deepEqual(metricHeadline(metric([observation("2026-11-08", 0)], "observed")), { kind: "value", value: 0, period: "2026-11-08", stale: false });
  assert.deepEqual(metricHeadline(metric([observation("2026-11-08", null)], "failed")), { kind: "failed", reason: "接続失敗", period: "2026-11-08", lastValue: null });
});

test("推移の読み上げは観測日数と最初・最後の値だけで、傾向を推測しない", () => {
  const window = trendWindow("2026-11-08", 7);
  const { points } = dailyPoints(metric([observation("2026-11-03", 10), observation("2026-11-07", 30), observation("2026-11-06", null)], "observed"), window);
  const text = trendSummary({ name: "月間売上", unit: "円" }, points, window);
  assert.match(text, /観測2日/);
  assert.match(text, /取得失敗1日/);
  assert.match(text, /最初 11\/3 10円/);
  assert.match(text, /最後 11\/7 30円/);
  assert.doesNotMatch(text, /増加|減少|改善/);
  assert.match(trendSummary({ name: "DAU", unit: "人" }, [], window), /日次の観測値はありません/);
});

const fact = (id: string, kind: "waiting_human" | "waiting_agent", updatedAt: number, reason = id) => ({ consultationId: id, kind, scope: "project" as const, title: id, reason, projectIds: [], taskIds: [], updatedAt });
const outcome = (problems: unknown) => ({ problems }) as never;

test("Workspaceの問題は代表の理由とほか件数を出し、同じ相談を重ねて数えない", () => {
  const a = fact("a", "waiting_agent", 1, "Agent対処");
  const b = fact("b", "waiting_human", 5, "決済機能の価格が未決定");
  const c = fact("c", "waiting_human", 9);
  const items = [
    outcome({ state: "present", representative: a, otherCount: 1, waitingHumanCount: 1, waitingAgentCount: 1, items: [a, b] }),
    outcome({ state: "present", representative: b, otherCount: 1, waitingHumanCount: 2, waitingAgentCount: 0, items: [b, c] }),
  ];
  const summary = summarizeWorkspaceProblems({ items, workspaceTotal: 2 });
  assert.equal(summary.state, "present");
  if (summary.state === "present") {
    assert.equal(summary.representative.consultationId, "b");
    assert.equal(summary.otherCount, 2);
    assert.equal(summary.unconfirmed, 0);
    assert.equal(summary.truncated, false);
  }
});

test("Workspaceの問題は取得失敗・対象なし・問題なしを区別する", () => {
  assert.deepEqual(summarizeWorkspaceProblems(null), { state: "unknown" });
  assert.deepEqual(summarizeWorkspaceProblems({ items: [], workspaceTotal: 0 }), { state: "no_outcomes" });
  assert.deepEqual(summarizeWorkspaceProblems({ items: [outcome({ state: "none" })], workspaceTotal: 1 }), { state: "none" });
  // 問題を確認できたOutcomeが無い、または一部しか読めていないときは問題なしと言わない。
  assert.deepEqual(summarizeWorkspaceProblems({ items: [outcome({ state: "unknown" })], workspaceTotal: 1 }), { state: "unknown" });
  assert.deepEqual(summarizeWorkspaceProblems({ items: [outcome({ state: "none" })], workspaceTotal: 150 }), { state: "unknown" });
  const present = summarizeWorkspaceProblems({ items: [outcome({ state: "present", representative: fact("a", "waiting_human", 1), otherCount: 0, waitingHumanCount: 1, waitingAgentCount: 0, items: [fact("a", "waiting_human", 1)] }), outcome({ state: "unknown" })], workspaceTotal: 2 });
  assert.equal(present.state === "present" && present.unconfirmed, 1);
});

test("対応待ちの件数は取得失敗を0にせず、上限を超えるときは+で示す", () => {
  assert.deepEqual(summarizeWaiting(null), { state: "unknown" });
  assert.equal(waitingCountText(summarizeWaiting(null)), "—");
  assert.equal(waitingCountText(summarizeWaiting({ consultations: [], nextCursor: null })), "0");
  assert.equal(waitingCountText({ state: "counted", count: 100, more: true }), "100+");
  assert.match(waitingCountPath("w1"), /^\/api\/consultations\?status=waiting_human&sort=due&workspaceId=w1&limit=100$/);
});

test("目標詳細のURLはWorkspaceの概要に属し、作成・編集は別の画面として扱う", () => {
  assert.equal(workspaceIntentPath("w1", "i1"), "/workspaces/w1/direction/intents/i1");
  assert.deepEqual(parseShellLocation("/workspaces/w1/direction/intents/i1"), { kind: "workspace", workspaceId: "w1", section: "overview" });
  assert.deepEqual(parseShellLocation("/workspaces/w1/direction/intents/new"), { kind: "workspace", workspaceId: "w1", section: null });
  assert.deepEqual(parseShellLocation("/workspaces/w1/direction/intents/i1/edit"), { kind: "workspace", workspaceId: "w1", section: null });
});
