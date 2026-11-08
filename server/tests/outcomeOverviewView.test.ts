import assert from "node:assert/strict";
import test from "node:test";
import { conditionsSearch, hasConditions, progressPercent, progressText, readConditions, type TaskProgress } from "../src/web/features/outcome/outcomeOverview.ts";
import { consultationDestination } from "../src/web/features/outcome/outcomeOverviewLinks.ts";

const counts = { todo: 0, doing: 0, in_review: 0, wait_accept: 0, accepted: 0, rejected: 0, canceled: 0 };
const progress = (overrides: Partial<TaskProgress>): TaskProgress => ({ kind: "counted", accepted: 0, denominator: 0, canceled: 0, total: 0, counts, ratio: null, ...overrides });

test("検索条件はURLに保持され、不正な値は既定へ戻る", () => {
  const conditions = readConditions(new URLSearchParams("q=初回&intentId=i1&problem=present&page=3"));
  assert.deepEqual(conditions, { q: "初回", intentId: "i1", problem: "present", page: 3 });
  assert.equal(conditionsSearch(conditions), "?q=%E5%88%9D%E5%9B%9E&intentId=i1&problem=present&page=3");
  assert.deepEqual(readConditions(new URLSearchParams("problem=bogus&page=0")), { q: "", intentId: "", problem: "", page: 1 });
  assert.equal(conditionsSearch(readConditions(new URLSearchParams(""))), "");
  assert.equal(hasConditions(readConditions(new URLSearchParams("page=2"))), false);
  assert.equal(hasConditions(readConditions(new URLSearchParams("problem=unknown"))), true);
});

test("進捗の文言は対象なし・未起票・Task0件・取消のみ・件数ありを区別し、分母0で割合を出さない", () => {
  assert.equal(progressText(progress({ kind: "no_target" })), "対象Projectなし");
  assert.equal(progressText(progress({ kind: "not_planned" })), "未起票");
  assert.equal(progressText(progress({ kind: "no_countable_tasks" })), "Task 0件");
  assert.equal(progressText(progress({ kind: "no_countable_tasks", canceled: 2, total: 2 })), "対象Taskなし（取消2件のみ）");
  assert.equal(progressText(progress({ accepted: 6, denominator: 10, ratio: 0.6 })), "受入済み 6 / 10件");
  assert.equal(progressPercent(progress({ kind: "no_target" })), null);
  assert.equal(progressPercent(progress({ accepted: 0, denominator: 4, ratio: 0 })), "0%");
  assert.equal(progressPercent(progress({ accepted: 6, denominator: 10, ratio: 0.6 })), "60%");
});

test("問題の遷移先は相談のscopeで決め、題名の文章は使わない", () => {
  const base = { consultationId: "c1", kind: "waiting_human", title: "t", reason: "r", taskIds: [] as string[], updatedAt: 1 } as const;
  assert.equal(consultationDestination("w1", { ...base, scope: "project", projectIds: ["p1"] }), "/projects/p1/consultations/c1");
  assert.equal(consultationDestination("w1", { ...base, scope: "workspace", projectIds: [] }), "/workspaces/w1/consultations/c1");
});
