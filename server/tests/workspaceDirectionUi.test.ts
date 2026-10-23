import assert from "node:assert/strict";
import test from "node:test";
import { contributionNote, latestCriterionVerdicts, noTargetNote, targetContributions } from "../src/web/features/direction/direction.ts";
import { buildOutcomeExecution, evaluationStage, type Evaluability, type TargetWork } from "../src/web/features/direction/overview.ts";

/** Workspaceの方向（S10-02）のOutcome → Target Project → Story / Evidence → 評価根拠の接続。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const work = (state: NonNullable<TargetWork["work"]>["state"], storyCount = 1): TargetWork["work"] => ({
  state, storyCount, taskCounts: { todo: 0, doing: 1, in_review: 0, wait_accept: 0, accepted: 0, rejected: 0, canceled: 0 },
});
const targetWork = (projectId: string, value: TargetWork["work"]): TargetWork => ({ outcomeId: "o-1", projectId, projectStatus: "active", createdAt: 1, work: value });

test("同一Outcomeの複数Target Projectを設定順に並べ、Target別Work・還流・評価可能性をProject別のまま結び付ける", () => {
  const evaluability: Evaluability = { status: "awaiting_execution", unfinishedTargets: [{ projectId: "p-b", projectStatus: "active", reason: "not_reflected" }] };
  const contributions = targetContributions(
    [
      { projectId: "p-a", projectStatus: "active", execution: { evidence: ["a"] } },
      { projectId: "p-b", projectStatus: "active", execution: null },
      { projectId: "p-c", projectStatus: "archived", execution: null },
    ],
    [targetWork("p-b", work("accepted")), targetWork("p-a", work("accepted"))],
    evaluability,
  );
  assert.deepEqual(contributions.map(({ projectId }) => projectId), ["p-a", "p-b", "p-c"]);
  assert.deepEqual(contributions[0].record, { evidence: ["a"] });
  assert.equal(contributions[1].unfinished, "not_reflected");
  // Target別Workの一覧に無いTarget（Story無し）はnull。
  assert.equal(contributions[2].work, null);
  assert.equal(contributionNote(contributions[0]), "結果は還流済みです");
  assert.equal(contributionNote(contributions[1]), "Workは終わり、結果の還流待ちです");
  assert.equal(contributionNote(contributions[2]), "Storyはありません（アーカイブ済み）");
});

test("Target別Workを取得できなければ、Storyなしと断定せず確認できない旨を出す", () => {
  const [contribution] = targetContributions([{ projectId: "p-a", projectStatus: "active", execution: null }], null, { status: "awaiting_execution", unfinishedTargets: [] });
  assert.equal(contribution.work, undefined);
  assert.equal(contributionNote(contribution), "Workの要約を確認できません");
  assert.equal(contributionNote({ ...contribution, work: null }), "Storyはまだありません（ProjectのManagerの起票待ち）");
  assert.equal(contributionNote({ ...contribution, work: work("incomplete"), unfinished: "incomplete" }), "Workは未完了です");
});

test("TargetなしのActive OutcomeはStrategistの判断待ちと出し、Active以外では判断待ちにしない", () => {
  assert.match(noTargetNote("active"), /Strategistの判断待ち/);
  assert.doesNotMatch(noTargetNote("cancelled"), /判断待ち/);
});

test("成功条件ごとの判定は最新Evaluation（新しい順の先頭）から読み、未評価なら空", () => {
  const verdicts = latestCriterionVerdicts([
    { criteria: [{ criterionId: "c-1", verdict: "met" }] },
    { criteria: [{ criterionId: "c-1", verdict: "not_met" }, { criterionId: "c-2", verdict: "not_met" }] },
  ]);
  assert.equal(verdicts.get("c-1")?.verdict, "met");
  assert.equal(verdicts.has("c-2"), false);
  assert.equal(latestCriterionVerdicts([]).size, 0);
});

test("最新Evaluationを根拠にしたDirection Decisionが無ければ判断待ち、Decisionを読めなければ段階を断定しない", () => {
  const executions = { targets: [{ projectId: "p-a", execution: { summary: { executionCursor: 3 } } }], evaluability: { status: "evaluable", unfinishedTargets: [] } as Evaluability };
  const evaluations = [{ id: "e-1", snapshot: { targets: [{ projectId: "p-a", execution: { executionCursor: 3 } }] } }];
  assert.equal(evaluationStage(buildOutcomeExecution(executions, evaluations, new Set())!), "decision_pending");
  assert.equal(evaluationStage(buildOutcomeExecution(executions, evaluations, new Set(["e-1"]))!), "decided");
  assert.equal(buildOutcomeExecution(executions, evaluations, null), null);
  assert.equal(evaluationStage(buildOutcomeExecution(executions, [], null)!), "evaluation_pending");
});
