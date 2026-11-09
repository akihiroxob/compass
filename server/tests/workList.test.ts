import assert from "node:assert/strict";
import test from "node:test";
import {
  allOutcomes,
  clearedWorkSearch,
  hasWorkCondition,
  parseWorkQuery,
  progressDenominator,
  progressPercent,
  readWorkBack,
  taskBlocker,
  workApiPath,
  workBackState,
  workSearch,
} from "../src/web/features/execution/work.ts";

/** 開発詳細（UI-W1）のURL条件・進捗・止まっている理由。検索・ページ取得はserverが行う（`workWebRead.test.ts`）。 */

const claim = { claimId: "c", principalId: "worker", expiresAt: 100 };
const task = (overrides: Record<string, unknown> = {}) => ({ status: "todo", activeClaim: null, rejectReason: null, consultationWait: null, reclaimable: false, ...overrides }) as Parameters<typeof taskBlocker>[0];

test("URLの条件は既定を省き、不正な値は既定へ戻し、`view`等の他のqueryを残す", () => {
  assert.deepEqual(parseWorkQuery(new URLSearchParams("")), { mode: "stories", q: "", status: "all", outcome: allOutcomes, story: null, page: 1 });
  assert.deepEqual(parseWorkQuery(new URLSearchParams("mode=tasks&q=a&status=rejected&outcome=none&story=s1&page=3")), { mode: "tasks", q: "a", status: "rejected", outcome: "none", story: "s1", page: 3 });
  assert.deepEqual(parseWorkQuery(new URLSearchParams("mode=x&status=x&page=0")), { mode: "stories", q: "", status: "all", outcome: allOutcomes, story: null, page: 1 });
  assert.equal(parseWorkQuery(new URLSearchParams("page=1.5")).page, 1);
  const current = new URLSearchParams("view=work&page=4");
  // 条件を変えるとページは1へ戻る。ページだけを変えるときは条件を残す。
  assert.equal(workSearch(current, { q: " 検索 " }), "?view=work&q=%E6%A4%9C%E7%B4%A2");
  assert.equal(workSearch(new URLSearchParams("view=work&q=a&status=done"), { page: 2 }), "?view=work&q=a&status=done&page=2");
  assert.equal(workSearch(new URLSearchParams("view=work&mode=tasks"), { mode: "stories" }), "?view=work");
  assert.equal(workSearch(current, { page: 1 }), "?view=work");
});

test("条件の有無と解除は表示形式を条件に数えず、`view`を残す", () => {
  assert.equal(hasWorkCondition(parseWorkQuery(new URLSearchParams("mode=tasks&page=2"))), false);
  assert.equal(hasWorkCondition(parseWorkQuery(new URLSearchParams("status=doing"))), true);
  assert.equal(hasWorkCondition(parseWorkQuery(new URLSearchParams("outcome=none"))), true);
  assert.equal(clearedWorkSearch(new URLSearchParams("view=work&mode=tasks&q=a&status=doing&outcome=o1&story=s1&page=2")), "?view=work&mode=tasks");
});

test("APIのpathは条件とページを渡し、既定は付けない", () => {
  assert.equal(workApiPath("p1", parseWorkQuery(new URLSearchParams(""))), "/api/projects/p1/work?view=stories");
  assert.equal(
    workApiPath("p1", parseWorkQuery(new URLSearchParams("mode=tasks&q=a b&status=awaiting_human&outcome=o1&story=s1&page=2"))),
    "/api/projects/p1/work?view=tasks&q=a+b&status=awaiting_human&outcome=o1&storyId=s1&page=2",
  );
});

test("Task進捗は取消を除いた分母で、Taskが無い・全て取消のときは0%にしない", () => {
  assert.equal(progressPercent({ accepted: 6, tasks: 10, canceled: 0 }), 60);
  assert.equal(progressPercent({ accepted: 3, tasks: 10, canceled: 2 }), 37);
  assert.equal(progressDenominator({ tasks: 10, canceled: 2 }), 8);
  assert.equal(progressPercent({ accepted: 0, tasks: 0, canceled: 0 }), null);
  assert.equal(progressPercent({ accepted: 0, tasks: 2, canceled: 2 }), null);
  assert.equal(progressPercent({ accepted: 0, tasks: 3, canceled: 0 }), 0);
});

test("止まっている理由は状態・差戻し理由・相談・Claimだけから判断し、Agentの稼働を推測しない", () => {
  assert.deepEqual(taskBlocker(task({ status: "rejected", rejectReason: "テスト不足" })), { side: "agent", reason: "差戻し: テスト不足" });
  assert.match(taskBlocker(task({ status: "rejected" }))!.reason, /理由は記録されていません/);
  assert.deepEqual(taskBlocker(task({ status: "wait_accept" })), { side: "human", reason: "受入の判断待ち" });
  assert.deepEqual(taskBlocker(task({ status: "in_review" })), { side: "human", reason: "レビューの確認待ち" });
  // Agentが期限内のClaimを持つレビュー・受入はHumanの対応待ちにしない。
  assert.equal(taskBlocker(task({ status: "in_review", activeClaim: claim })), null);
  assert.equal(taskBlocker(task({ status: "doing", activeClaim: claim })), null);
  assert.deepEqual(taskBlocker(task({ status: "doing", reclaimable: true })), { side: "agent", reason: "Claimの期限切れ（再取得待ち）" });
  const wait = (cause: string) => task({ status: "doing", consultationWait: { state: "waiting", phase: "work", consultations: [], failureReason: null, cause } });
  assert.deepEqual(taskBlocker(wait("human")), { side: "human", reason: "Humanへの相談の回答待ち" });
  assert.deepEqual(taskBlocker(wait("agent")), { side: "agent", reason: "相談へのAgentの応答待ち" });
  assert.deepEqual(taskBlocker(wait("continuation")), { side: "agent", reason: "相談の結論後、Managerの継続確認待ち" });
  assert.deepEqual(taskBlocker(wait("ready")), { side: "agent", reason: "相談の結論を受けて再開待ち" });
  assert.deepEqual(taskBlocker(wait("resuming")), { side: "agent", reason: "相談の結論を受けて再開中" });
  assert.equal(taskBlocker(task({ status: "accepted" })), null);
  assert.equal(taskBlocker(task({ status: "todo" })), null);
});

test("Task詳細の戻り先は、同じProjectの開発詳細のqueryだけを受け付ける", () => {
  const state = workBackState("p1", "?view=work&q=a&page=2");
  assert.equal(readWorkBack(state, "p1"), "/projects/p1?view=work&q=a&page=2");
  assert.equal(readWorkBack(state, "p2"), "/projects/p2?view=work");
  assert.equal(readWorkBack(null, "p1"), "/projects/p1?view=work");
  assert.equal(readWorkBack({ workBack: "https://evil.example/" }, "p1"), "/projects/p1?view=work");
});

test("Storyの成功条件は位置順に表示用へ整える", async () => {
  const { storyCriteria } = await import("../src/web/features/execution/work.ts");
  const c = (id: string, position: number) => ({ id, position, description: `d${id}`, measurement: `m${id}`, target: null });
  assert.deepEqual(storyCriteria({ successCriteria: [c("b", 2), c("a", 1)] }).map((item) => item.id), ["a", "b"]);
  assert.deepEqual(storyCriteria({ successCriteria: null }), []);
  assert.deepEqual(storyCriteria({}), []);
});
