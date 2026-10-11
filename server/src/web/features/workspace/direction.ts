// Workspaceの方向（S10-02）の判定。Outcome → Target Project → Story / Task・Evidence → 評価根拠の接続を、取得済みの応答から導く純関数。
// 導線の表示だけを決め、拒否は常にserverが行う。テストからも読み込むため、純関数のmodule以外をimportしない。
import type { Evaluability, TargetWork } from "./overview.ts";

/** target-executionsのTarget 1件のうち、方向が使う部分。`execution`は還流前ならnull。 */
export type TargetExecutionRecord<Record> = { projectId: string; projectStatus: "active" | "archived"; execution: Record | null };

/**
 * Target Project 1件の貢献。`work`はTarget別Workの要約（Storyが無ければnull、Target別Workを取得できなければundefined）、
 * `record`は還流済みのExecution Summary・Evidence、`unfinished`は評価可能性から見た未完了の理由（完了ならnull）。
 */
export type TargetContribution<Record> = {
  projectId: string;
  projectStatus: "active" | "archived";
  work: TargetWork["work"] | undefined;
  record: Record | null;
  unfinished: Evaluability["unfinishedTargets"][number]["reason"] | null;
};

/**
 * Targetの設定順（target-executionsの順）に、Target別Work・還流・評価可能性を結び付ける。`workTargets`はTarget別Workの一覧
 * （取得できなければnull）で、Project別のまま合算しない。
 */
export const targetContributions = <Record,>(
  targets: readonly TargetExecutionRecord<Record>[],
  workTargets: readonly TargetWork[] | null,
  evaluability: Evaluability,
): TargetContribution<Record>[] => {
  const works = workTargets ? new Map(workTargets.map((target) => [target.projectId, target.work])) : null;
  const unfinished = new Map(evaluability.unfinishedTargets.map((target) => [target.projectId, target.reason]));
  return targets.map(({ projectId, projectStatus, execution }) => ({
    projectId,
    projectStatus,
    work: works === null ? undefined : works.get(projectId) ?? null,
    record: execution,
    unfinished: unfinished.get(projectId) ?? null,
  }));
};

/**
 * Target Projectが無いOutcomeの説明。ActiveなOutcomeは担当Projectの決定がStrategistの判断待ちで、Storyは起票されない。
 * 取消・評価済み等のOutcomeは判断待ちとして出さない。
 */
export const noTargetNote = (outcomeStatus: string): string =>
  outcomeStatus === "active"
    ? "Target Projectはまだありません。担当するProjectはStrategistの判断待ちで、決まるまでStoryは起票されません。"
    : "Target Projectはありません。";

/** Target 1件のWorkの段階の説明。Story / Taskの件数は状態だけを数えたもので、Agentの稼働を示さない。 */
export const contributionNote = (contribution: Pick<TargetContribution<unknown>, "work" | "record" | "unfinished" | "projectStatus">): string => {
  if (contribution.work === undefined) return "Workの要約を確認できません";
  if (contribution.work === null) return contribution.projectStatus === "archived" ? "Storyはありません（アーカイブ済み）" : "Storyはまだありません（ProjectのManagerの起票待ち）";
  if (contribution.unfinished === "incomplete") return "Workは未完了です";
  if (contribution.unfinished === "not_reflected") return contribution.work.state === "incomplete" ? "Workは未完了です" : "Workは終わり、結果の還流待ちです";
  return contribution.record ? "結果は還流済みです" : "Workは未完了です";
};

/** 成功条件ごとの最新Evaluationの判定。Evaluationが無ければ空。評価時の成功条件IDで対応付ける。 */
export const latestCriterionVerdicts = <Criterion extends { criterionId: string }>(evaluations: readonly { criteria: readonly Criterion[] }[]): Map<string, Criterion> =>
  new Map((evaluations[0]?.criteria ?? []).map((criterion) => [criterion.criterionId, criterion]));
