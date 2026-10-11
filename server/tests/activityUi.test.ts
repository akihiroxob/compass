import assert from "node:assert/strict";
import test from "node:test";
import {
  activitiesPath,
  activityTypeGroups,
  activityTypeLabel,
  activityTypeSearch,
  appendActivityPage,
  describeReference,
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
