import type { UsedSynthesisReference } from "./DirectionDecision.ts";

/**
 * `adr_candidate` Direction Decisionから、既存Wacha Manager / Worker / Reviewerへ渡す依頼のfixture payload。
 * Compassが方針（何をADRへ書くか）を確定し、Wachaは対象Repositoryの既存ADR規約に従って文書反映だけを実行する。
 * `expectedAdrContent`はDecisionの`judgment` / `reason` / `options`から決定的に組み立て、判断時点でsnapshotする
 * （呼び出し側が別の自由記述を渡すのではなく、既に記録済みのDirection Decisionの内容だけを転記する）。
 */
export type AdrHandoffRequestPayload = {
  readonly decisionId: string;
  readonly intentId: string;
  readonly usedSyntheses: readonly UsedSynthesisReference[];
  readonly usedFindingIds: readonly string[];
  readonly repositoryId: string;
  readonly repositoryName: string;
  readonly repositoryUrl: string;
  readonly constraints: readonly string[];
  readonly expectedAdrContent: string;
};

/** Wachaへの依頼として生成し保存したfixture。作成後は変更しない。 */
export type AdrHandoffRequest = {
  readonly id: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly repositoryId: string;
  readonly correlationId: string;
  readonly requestKey: string;
  readonly payload: AdrHandoffRequestPayload;
  readonly principalId: string;
  readonly createdAt: number;
};

/**
 * WachaのADR作成完了結果としてCompassへ戻す参照。Repository本文の複製ではなく、path / commit SHA / PR URLへの参照。
 * `path`はProjectに登録されたRepository内の相対pathで、Compass serverのローカルfilesystem pathではない。
 */
export type AdrReference = {
  readonly id: string;
  readonly projectId: string;
  readonly decisionId: string;
  readonly repositoryId: string;
  readonly path: string;
  readonly commitSha: string;
  readonly pullRequestUrl: string | null;
  readonly correlationId: string;
  readonly requestKey: string;
  readonly principalId: string;
  readonly createdAt: number;
};
