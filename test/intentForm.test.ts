import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, classifyError, formatIssuePath } from "../src/frontend/api.ts";
import {
  emptyIntentFormValues,
  formValuesFromIntent,
  splitIntents,
  type Intent,
} from "../src/frontend/intentForm.ts";

const intent = (overrides: Partial<Intent>): Intent => ({
  id: "i1",
  projectId: "p1",
  title: "Title",
  desiredState: "State",
  completionDefinition: null,
  status: "active",
  abandonedReason: null,
  createdAt: 1,
  updatedAt: 1,
  ...overrides,
});

test("保存済みIntentから編集フォームの初期値を作り、未設定は空欄にする", () => {
  assert.deepEqual(formValuesFromIntent(intent({})), { title: "Title", desiredState: "State", completionDefinition: "" });
  assert.equal(formValuesFromIntent(intent({ completionDefinition: "Done" })).completionDefinition, "Done");
  assert.deepEqual(emptyIntentFormValues, { title: "", desiredState: "", completionDefinition: "" });
});

test("Activeなintentと過去のIntentを分け、過去は受け取った順を保つ", () => {
  const active = intent({ id: "a" });
  const abandoned = intent({ id: "b", status: "abandoned" });
  const achieved = intent({ id: "c", status: "achieved" });
  assert.deepEqual(splitIntents([active, abandoned, achieved]), { active, past: [abandoned, achieved] });
  assert.deepEqual(splitIntents([abandoned]), { active: null, past: [abandoned] });
  assert.deepEqual(splitIntents([]), { active: null, past: [] });
});

test("Intent項目のissue pathをフォームのラベルへ対応づける", () => {
  assert.equal(formatIssuePath("title"), "タイトル");
  assert.equal(formatIssuePath("desiredState"), "実現したい状態");
  assert.equal(formatIssuePath("completionDefinition"), "完了の定義");
  assert.equal(formatIssuePath("reason"), "放棄の理由");
});

test("409 CONFLICTはActive Intentのidを保持した競合として分類する", () => {
  const conflict = new ApiError(409, "CONFLICT", "Project p1 already has an active Intent", [], "i1");
  assert.deepEqual(classifyError(conflict), {
    kind: "conflict",
    message: "Project p1 already has an active Intent",
    activeIntentId: "i1",
  });
  assert.deepEqual(classifyError(new ApiError(409, "CONFLICT", "Intent is abandoned")), {
    kind: "conflict",
    message: "Intent is abandoned",
    activeIntentId: null,
  });
  assert.deepEqual(classifyError(new ApiError(409, "OTHER", "x")), { kind: "other", message: "x" });
});
