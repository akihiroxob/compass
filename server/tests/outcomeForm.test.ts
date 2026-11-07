import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, classifyError, fieldId, formatIssuePath } from "../src/web/api.ts";
import {
  emptyCriterion,
  emptyOutcomeFormValues,
  emptyProblem,
  planRunState,
  problemsInput,
  formValuesFromOutcome,
  maxSuccessCriteria,
  isReplanTarget,
  replanNote,
  splitOutcomes,
  type Outcome,
} from "../src/web/features/outcome/outcome.ts";

const outcome = (overrides: Partial<Outcome>): Outcome => ({
  id: "o1",
  workspaceId: "w1",
  intentId: "i1",
  intentVersion: 1,
  title: "Title",
  description: "Description",
  hypothesis: null,
  rationale: "Rationale",
  status: "active",
  cancelReason: null,
  originDecisionId: null,
  successCriteria: [
    { id: "c1", outcomeId: "o1", position: 0, description: "First", measurement: "Measured", target: null },
    { id: "c2", outcomeId: "o1", position: 1, description: "Second", measurement: "Observed", target: "= 0" },
  ],
  problems: [],
  revision: 1,
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

test("編集フォームの初期値は課題の観測と原因の仮説を別の欄に保ち、根拠参照を引き継ぐ", () => {
  const evidence = [{ kind: "research_finding" as const, id: "f1", requestId: "r1", summary: "離脱", superseded: false }];
  const values = formValuesFromOutcome(
    outcome({
      problems: [
        { id: "p1", outcomeId: "o1", position: 0, statement: "課題", evidenceStatus: "observed", observation: "step 2で離脱", causeHypothesis: null, solutionHypothesis: "入力を減らす", evaluationPlan: null, evidence },
      ],
    }),
  );
  assert.deepEqual(values.problems, [
    { id: "p1", statement: "課題", evidenceStatus: "observed", observation: "step 2で離脱", causeHypothesis: "", solutionHypothesis: "入力を減らす", evaluationPlan: null, evidence },
  ]);
  assert.deepEqual(emptyOutcomeFormValues.problems, []);
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
    conflict: null,
  });
});

test("目標の意味が根拠にした版より後に変わった未完了のOutcomeだけを再計画対象にする", () => {
  assert.equal(isReplanTarget(outcome({ intentVersion: 1 }), { meaningVersion: 2 }), true);
  assert.equal(isReplanTarget(outcome({ intentVersion: 2 }), { meaningVersion: 2 }), false, "現在の意味を確認済み");
  assert.equal(isReplanTarget(outcome({ intentVersion: 1, status: "cancelled" }), { meaningVersion: 3 }), false, "取消済みは対象外");
  assert.equal(isReplanTarget(outcome({ intentVersion: 1, status: "achieved" }), { meaningVersion: 3 }), false, "評価済みの結果は書き換えない");
  assert.match(replanNote(outcome({ intentVersion: 1 }), { meaningVersion: 3 }), /v1.*v3/);
});

test("評価計画は空の任意項目をnullにして送り、保存済みの計画を編集フォームへ戻せる", () => {
  const plan = { question: "完了率は上がるか", method: "ab_test" as const, premises: "無作為割付", observationPeriod: "", decisionCriteria: "完了率+5pt", stopCriteria: "" };
  const [sent] = problemsInput([{ ...emptyProblem, statement: "離脱", evaluationPlan: plan }]);
  assert.deepEqual(sent!.evaluationPlan, { question: "完了率は上がるか", method: "ab_test", premises: "無作為割付", observationPeriod: null, decisionCriteria: "完了率+5pt", stopCriteria: null });
  assert.equal(problemsInput([{ ...emptyProblem, statement: "離脱" }])[0]!.evaluationPlan, null);
  const restored = formValuesFromOutcome(outcome({ problems: [{ id: "p1", outcomeId: "o1", position: 0, statement: "離脱", evidenceStatus: "insufficient", observation: null, causeHypothesis: null, solutionHypothesis: null, evaluationPlan: { ...plan, premises: "無作為割付", observationPeriod: null, stopCriteria: null }, evidence: [] }] }));
  assert.deepEqual(restored.problems[0]!.evaluationPlan, plan);
});

test("評価計画は、その課題を対象にした評価があるまで未実施として扱う", () => {
  assert.equal(planRunState("p1", []), "not_run");
  assert.equal(planRunState("p1", [{ problemIds: ["p2"] }]), "not_run");
  assert.equal(planRunState("p1", [{ problemIds: ["p2"] }, { problemIds: ["p1"] }]), "run");
});
