import assert from "node:assert/strict";
import test from "node:test";
import { appendActivityPage, describeReference, type ActivitySummary } from "../src/web/features/activity/activity.ts";

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

test("古いページは重複したcursorを除いて末尾へ足す", () => {
  const item = (cursor: number) => ({ cursor }) as ActivitySummary;
  assert.deepEqual(appendActivityPage([item(3), item(2)], [item(2), item(1)]).map(({ cursor }) => cursor), [3, 2, 1]);
});
