import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, classifyError, fieldId, formatIssuePath } from "../src/frontend/api.ts";
import {
  emptyCriterion,
  emptyOutcomeFormValues,
  formValuesFromOutcome,
  maxSuccessCriteria,
  splitOutcomes,
  type Outcome,
} from "../src/frontend/outcomeForm.ts";

const outcome = (overrides: Partial<Outcome>): Outcome => ({
  id: "o1",
  projectId: "p1",
  intentId: "i1",
  title: "Title",
  description: "Description",
  hypothesis: null,
  rationale: "Rationale",
  status: "active",
  cancelReason: null,
  successCriteria: [
    { id: "c1", outcomeId: "o1", position: 0, description: "First", measurement: "Measured", target: null },
    { id: "c2", outcomeId: "o1", position: 1, description: "Second", measurement: "Observed", target: "= 0" },
  ],
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test("新規フォームは成功条件の空1行から始まり、上限はサーバーの規則と同じ10件", () => {
  assert.deepEqual(emptyOutcomeFormValues.successCriteria, [emptyCriterion]);
  assert.deepEqual(emptyCriterion, { description: "", measurement: "", target: "" });
  assert.equal(maxSuccessCriteria, 10);
});

test("保存済みOutcomeから編集フォームの初期値を作り、未設定は空欄にして成功条件の順を保つ", () => {
  const values = formValuesFromOutcome(outcome({ hypothesis: "Because" }));
  assert.equal(values.hypothesis, "Because");
  assert.equal(formValuesFromOutcome(outcome({})).hypothesis, "");
  assert.deepEqual(values.successCriteria, [
    { description: "First", measurement: "Measured", target: "" },
    { description: "Second", measurement: "Observed", target: "= 0" },
  ]);
});

test("ActiveなOutcomeとそれ以外を分け、受け取った順を保つ", () => {
  const a = outcome({ id: "a" });
  const b = outcome({ id: "b", status: "cancelled" });
  const c = outcome({ id: "c" });
  assert.deepEqual(splitOutcomes([a, b, c]), { active: [a, c], past: [b] });
  assert.deepEqual(splitOutcomes([]), { active: [], past: [] });
});

test("Outcome項目のissue pathを、成功条件の行位置を含むラベルとfield idへ対応づける", () => {
  assert.equal(formatIssuePath("hypothesis"), "仮説");
  assert.equal(formatIssuePath("rationale"), "判断理由");
  assert.equal(formatIssuePath("successCriteria"), "成功条件");
  assert.equal(formatIssuePath("successCriteria.1.measurement"), "成功条件 2の測定方法");
  assert.equal(formatIssuePath("successCriteria.0.description"), "成功条件 1の内容");
  assert.equal(formatIssuePath("successCriteria.2.target"), "成功条件 3の目標値");
  assert.equal(fieldId("successCriteria.1.measurement"), "field-successCriteria-1-measurement");
  // 既存のProject項目のラベルは変わらない。
  assert.equal(formatIssuePath("repositories.1.url"), "Repositories 2のURL");
  assert.equal(formatIssuePath("description"), "説明");
});

test("Outcomeの409 CONFLICTは、Active Intentを持たない競合として分類する", () => {
  const conflict = new ApiError(409, "CONFLICT", "Intent i1 is abandoned; Outcomes can only be created under an active Intent");
  assert.deepEqual(classifyError(conflict), {
    kind: "conflict",
    message: "Intent i1 is abandoned; Outcomes can only be created under an active Intent",
    activeIntentId: null,
  });
});
