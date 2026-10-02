/** ExecutionがStory作成時に受け取る、Success Criterionの作成時snapshot。 */
export type SuccessCriterionSnapshot = {
  id: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
};

/** Story作成時にDirectionから1回だけ取得する、Outcomeの参照とsnapshot。Execution側で更新・再取得しない。 */
export type OutcomeReferenceSnapshot = {
  outcomeId: string;
  /** 判断したDirection Decision。Decisionを経由しないOutcomeはnull。 */
  originDecisionId: string | null;
  /** `active`以外のOutcomeからはStoryを作らないため、呼び出し側が検査に使う。 */
  status: string;
  /** Outcome作成時に固定されたSuccess Criteria。 */
  successCriteria: SuccessCriterionSnapshot[];
  /** 取得時点のProject Constraints。 */
  constraints: string[];
};

/** Project登録済みRepositoryの参照。実際のcheckoutやfilesystemパスはRuntime / Agentの責務で、Compassは持たない。 */
export type RepositoryReference = { id: string; name: string; url: string };

/**
 * Execution → Directionの読取専用ポート。ExecutionはDirectionのRepository・tableを直接使わず、
 * `issue_story`でOutcome・Repositoryを参照するときだけこのポートを通す。書込メソッドは意図的に持たない。
 * 別ProjectのID・存在しないIDはnull（存在を区別して漏らさない）。
 */
export interface DirectionReferenceLookupPort {
  getOutcomeSnapshot(projectId: string, outcomeId: string): Promise<OutcomeReferenceSnapshot | null>;
  getRepositoryReference(projectId: string, repositoryId: string): Promise<RepositoryReference | null>;
}
