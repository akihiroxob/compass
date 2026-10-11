import assert from "node:assert/strict";
import test from "node:test";
import {
  activitiesPath,
  activityTypeGroups,
  activityTypeLabel,
  activityListReducer,
  activityTypeSearch,
  appendActivityPage,
  describeReference,
  initialActivityList,
  parseActivityTypeFilter,
  type ActivitySummary,
} from "../src/web/features/activity/activity.ts";

/** Web UIのActivity表示。成果物は正本へのlinkだけを出し、Web UI内のEntityは対応する画面へ辿る。 */

const resources = [{ id: "repo-1", name: "primary", url: "https://example.com/compass.git" }];

test("Project Resourceの参照は登録済みのURLとpath・revisionで表示し、本文を持たない", () => {
  assert.deepEqual(
    describeReference({ kind: "project_resource", resourceId: "repo-1", path: "docs/auth.md", revision: "0123456789abcdef" }, resources),
    { label: "primary", detail: "docs/auth.md @ 0123456789ab", href: "https://example.com/compass.git" },
  );
  assert.deepEqual(describeReference({ kind: "project_resource", resourceId: "gone", path: null, revision: null }, resources), {
    label: "登録が外れたResource gone",
    detail: null,
  });
  // 登録済みResourceの一覧を取得できていなければ、登録が外れたとは断定しない。
  assert.deepEqual(describeReference({ kind: "project_resource", resourceId: "repo-1", path: null, revision: null }, null), {
    label: "Resource repo-1",
    detail: null,
  });
  assert.deepEqual(describeReference({ kind: "url", url: "https://example.com/rfc" }, resources), {
    label: "https://example.com/rfc",
    detail: null,
    href: "https://example.com/rfc",
  });
});

test("Entityの参照は表示できる画面へ辿り、画面の無いものはIDだけを出す", () => {
  assert.deepEqual(describeReference({ kind: "task", id: "task-123456789" }, []), {
    label: "Task task-123",
    detail: null,
    screen: { kind: "task", id: "task-123456789" },
  });
  assert.deepEqual(describeReference({ kind: "research_request", id: "r1" }, []).screen, { kind: "research_request", id: "r1" });
  assert.deepEqual(describeReference({ kind: "outcome", id: "outcome-123456" }, []), { label: "Outcome outcome-", detail: null });
});

test("Outcomeの参照は同じActivityのIntentが1件に決まるときだけWorkspaceのOutcome詳細へ辿る", () => {
  const outcome = { kind: "outcome", id: "o1" } as const;
  assert.deepEqual(describeReference(outcome, [], [outcome, { kind: "intent", id: "i1" }]).screen, { kind: "outcome", id: "o1", intentId: "i1" });
  assert.equal(describeReference(outcome, [], [outcome]).screen, undefined);
  assert.equal(describeReference(outcome, [], [outcome, { kind: "intent", id: "i1" }, { kind: "intent", id: "i2" }]).screen, undefined);
});

test("一覧のURLはscope別のWeb APIへページと種別を渡す", () => {
  assert.equal(activitiesPath({ kind: "project", projectId: "p1" }), "/api/projects/p1/activities?limit=20");
  assert.equal(
    activitiesPath({ kind: "workspace", workspaceId: "w1" }, { beforeCursor: 9, type: "decision.recorded", limit: 5 }),
    "/api/workspaces/w1/activities?limit=5&beforeCursor=9&type=decision.recorded",
  );
});

test("種別の絞り込みはscopeごとの状態変更だけを選択肢にし、URLの形式外の値は全件として扱う", () => {
  const types = (kind: "project" | "workspace") => activityTypeGroups[kind].flatMap((group) => group.types.map(({ type }) => type));
  // Project ActivityはWork、Workspace ActivityはDirectionの種別で、互いを含めない。
  assert.ok(types("project").every((type) => /^(story|task|project)\./.test(type)));
  assert.ok(types("workspace").every((type) => /^(intent|outcome|research|decision)\./.test(type)));
  assert.equal(activityTypeLabel("workspace", "decision.recorded"), "Direction Decisionの記録");
  assert.equal(activityTypeLabel("project", "decision.recorded"), null);
  assert.equal(parseActivityTypeFilter("research.summary"), "research.summary");
  for (const invalid of [null, "", "Task.Created", "task..created", "a".repeat(101)]) assert.equal(parseActivityTypeFilter(invalid), null);
  assert.equal(activityTypeSearch(new URLSearchParams("view=records"), "task.accepted"), "?view=records&type=task.accepted");
  assert.equal(activityTypeSearch(new URLSearchParams("view=records&type=task.accepted"), null), "?view=records");
  assert.equal(activityTypeSearch(new URLSearchParams("type=task.accepted"), null), "");
});

test("古いページは重複したcursorを除いて末尾へ足す", () => {
  const item = (cursor: number) => ({ cursor }) as ActivitySummary;
  assert.deepEqual(appendActivityPage([item(3), item(2)], [item(2), item(1)]).map(({ cursor }) => cursor), [3, 2, 1]);
});

test("種別を変えた後に返った古い追加読込の成功・失敗は、一覧・cursor・エラー・読込中へ混入しない", () => {
  const item = (cursor: number, type: string) => ({ cursor, type }) as ActivitySummary;
  const all = "project:p1#";
  const accepted = "project:p1#task.accepted";
  let state = activityListReducer(initialActivityList(all, 1), { kind: "loaded", generation: 1, page: { activities: [item(30, "task.created")], nextCursor: 30 } });
  // 全件で追加読込を始めたまま、種別をtask.acceptedへ変える。
  state = activityListReducer(state, { kind: "moreStarted", generation: 1 });
  assert.equal(state.pending, true);
  state = activityListReducer(state, { kind: "reset", key: accepted, generation: 2 });
  assert.equal(state.pending, false);
  state = activityListReducer(state, { kind: "loaded", generation: 2, page: { activities: [item(40, "task.accepted")], nextCursor: 40 } });
  // 絞り込み結果の取得後に、全件の旧ページ・旧エラーが返る。
  const current = state;
  state = activityListReducer(state, { kind: "moreLoaded", generation: 1, page: { activities: [item(20, "story.created")], nextCursor: 20 } });
  state = activityListReducer(state, { kind: "moreFailed", generation: 1, message: "古いActivityを読み込めませんでした" });
  state = activityListReducer(state, { kind: "failed", generation: 1, message: "失敗" });
  assert.equal(state, current);
  assert.deepEqual(state.activities?.map(({ type }) => type), ["task.accepted"]);
  assert.equal(state.nextCursor, 40);
  // 現在の条件では続けて追加読込でき、最後のページで末尾に達する。
  state = activityListReducer(state, { kind: "moreStarted", generation: 2 });
  state = activityListReducer(state, { kind: "moreLoaded", generation: 2, page: { activities: [item(35, "task.accepted")], nextCursor: null } });
  assert.deepEqual(state.activities?.map(({ cursor }) => cursor), [40, 35]);
  assert.equal(state.nextCursor, null);
  assert.equal(state.pending, false);
  assert.equal(state.reachedEnd, true);
  assert.equal(state.moreError, null);
  assert.equal(state.error, null);
});

test("同じ条件へ戻った（A → B → A）後に返った旧世代の初回取得・追加読込は、現在の一覧・cursor・エラー・読込中・末尾へ混入しない", () => {
  const item = (cursor: number) => ({ cursor, type: "task.created" }) as ActivitySummary;
  const all = "project:p1#";
  // 世代1（全件）: 初回取得を保留したまま、別の世代1の追加読込も保留中とみなす。
  let state = initialActivityList(all, 1);
  // 種別を変え（世代2）、全件へ戻す（世代3）。条件の文字列は世代1と同じ。
  state = activityListReducer(state, { kind: "reset", key: "project:p1#task.accepted", generation: 2 });
  state = activityListReducer(state, { kind: "reset", key: all, generation: 3 });
  assert.equal(state.key, all);
  state = activityListReducer(state, { kind: "loaded", generation: 3, page: { activities: [item(60), item(50)], nextCursor: 50 } });
  state = activityListReducer(state, { kind: "moreStarted", generation: 3 });
  const current = state;
  // 世代1の初回取得の成功・失敗、追加読込の成功・失敗が遅れて返る。
  state = activityListReducer(state, { kind: "loaded", generation: 1, page: { activities: [item(30), item(20)], nextCursor: 20 } });
  state = activityListReducer(state, { kind: "failed", generation: 1, message: "失敗" });
  state = activityListReducer(state, { kind: "moreLoaded", generation: 1, page: { activities: [item(10)], nextCursor: null } });
  state = activityListReducer(state, { kind: "moreFailed", generation: 1, message: "古いActivityを読み込めませんでした" });
  state = activityListReducer(state, { kind: "moreStarted", generation: 1 });
  assert.equal(state, current);
  assert.deepEqual(state.activities?.map(({ cursor }) => cursor), [60, 50]);
  assert.equal(state.nextCursor, 50);
  assert.equal(state.pending, true);
  assert.equal(state.error, null);
  assert.equal(state.moreError, null);
  assert.equal(state.reachedEnd, false);
  // 現在の世代の追加読込はそのまま続けられる。
  state = activityListReducer(state, { kind: "moreLoaded", generation: 3, page: { activities: [item(40)], nextCursor: 40 } });
  assert.deepEqual(state.activities?.map(({ cursor }) => cursor), [60, 50, 40]);
  assert.equal(state.nextCursor, 40);
  assert.equal(state.pending, false);
  assert.equal(state.reachedEnd, false);
});

test("追加読込の失敗は現在の条件の一覧を残してエラーを出し、再試行で消える", () => {
  const key = "workspace:w1#";
  let state = activityListReducer(initialActivityList(key), { kind: "loaded", generation: 0, page: { activities: [{ cursor: 9 } as ActivitySummary], nextCursor: 9 } });
  state = activityListReducer(activityListReducer(state, { kind: "moreStarted", generation: 0 }), { kind: "moreFailed", generation: 0, message: "読み込めません" });
  assert.equal(state.moreError, "読み込めません");
  assert.equal(state.pending, false);
  assert.equal(state.nextCursor, 9);
  assert.equal(state.activities?.length, 1);
  state = activityListReducer(state, { kind: "moreStarted", generation: 0 });
  assert.equal(state.moreError, null);
});
