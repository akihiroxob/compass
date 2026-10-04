import assert from "node:assert/strict";
import test from "node:test";
import { storyEmptyMessage } from "../src/web/features/execution/execution.ts";
import { outcomeEmptyMessage } from "../src/web/outcomeForm.ts";
import { registrationUnavailableNote } from "../src/web/projectAccess.ts";

/** 空状態の案内（Task 05）。画面の描画・実ブラウザ確認はTaskの作業コメントに記録する。 */

test("登録できない空一覧には理由と依頼先を示し、登録できる・判定中は導線だけにする", () => {
  assert.equal(registrationUnavailableNote("allowed", "Intent"), null);
  assert.equal(registrationUnavailableNote("loading", "Intent"), null);
  assert.equal(registrationUnavailableNote("error", "Intent"), null);
  assert.equal(registrationUnavailableNote("archived", "Intent"), "アーカイブ済みのため、Intentは登録できません。");
  assert.match(registrationUnavailableNote("forbidden", "Intent") ?? "", /ownerにRoleの変更を依頼/);
});

test("Storyの空一覧は起票するAgentを示し、手動起票は起票できる場合だけ案内する", () => {
  assert.match(storyEmptyMessage("allowed"), /Managerが起票/);
  assert.match(storyEmptyMessage("allowed"), /「Storyを起票」/);
  for (const access of ["forbidden", "loading", "error"] as const) {
    assert.match(storyEmptyMessage(access), /Managerが起票/);
    assert.doesNotMatch(storyEmptyMessage(access), /「Storyを起票」/);
  }
  assert.equal(storyEmptyMessage("archived"), "Storyはありません。アーカイブ済みのため、新しいStoryは起票されません。");
});

test("Outcomeの空一覧は、Active Intentの場合だけ登録の担い手を示す", () => {
  assert.match(outcomeEmptyMessage("active", "allowed", false), /Strategist/);
  assert.match(outcomeEmptyMessage("active", "allowed", false), /「Outcomeを登録」/);
  assert.match(outcomeEmptyMessage("active", "forbidden", false), /Strategist/);
  assert.doesNotMatch(outcomeEmptyMessage("active", "forbidden", false), /「Outcomeを登録」/);
  assert.equal(outcomeEmptyMessage("active", "archived", false), "Outcomeはありません。");
  assert.equal(outcomeEmptyMessage("abandoned", "allowed", false), "Outcomeはありません。");
  assert.match(outcomeEmptyMessage("active", "allowed", true), /^ActiveなOutcomeはありません。/);
  assert.equal(outcomeEmptyMessage("achieved", "allowed", true), "ActiveなOutcomeはありません。");
});
