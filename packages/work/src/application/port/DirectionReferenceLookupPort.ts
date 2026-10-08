/** ExecutionがStory作成時に受け取る、Success Criterionの作成時snapshot。 */
export type SuccessCriterionSnapshot = {
  id: string;
  position: number;
  description: string;
  measurement: string;
  target: string | null;
};

/** Story作成時にDirectionから1回だけ取得する、Workspace所有のOutcomeの参照とsnapshot。Execution側で更新・再取得しない。 */
export type OutcomeReferenceSnapshot = {
  outcomeId: string;
  /** 判断したDirection Decision。Decisionを経由しないOutcomeはnull。 */
  originDecisionId: string | null;
  /** `active`以外のOutcomeからはStoryを作らないため、呼び出し側が検査に使う。 */
  status: string;
  /** Outcome作成時に固定されたSuccess Criteria。 */
  successCriteria: SuccessCriterionSnapshot[];
  /** 取得時点のTarget Project ID。Targetでない（解除済みを含む）ProjectにはStoryを作らないため、呼び出し側が検査に使う。 */
  targetProjectIds: string[];
};

/** Project登録済みRepositoryの参照。実際のcheckoutやfilesystemパスはRuntime / Agentの責務で、Compassは持たない。 */
export type RepositoryReference = { id: string; name: string; url: string };

/** Story作成時に読む、Project（実行の境界）の所属Workspaceと実行に使う参照。 */
export type ProjectExecutionContext = {
  projectId: string;
  workspaceId: string;
  /** 取得時点の所属WorkspaceのConstraints。 */
  constraints: string[];
  /** Project登録済みのRepository。 */
  repositories: RepositoryReference[];
};

/**
 * Execution → Directionの読取専用ポート。ExecutionはDirectionのRepository・tableを直接使わず、
 * `issue_story`でOutcome・Repositoryを参照するときだけこのポートを通す。書込メソッドは意図的に持たない。
 * Outcomeは所属Workspaceで読み、別WorkspaceのID・存在しないIDはnull（存在を区別して漏らさない）。
 */
export interface DirectionReferenceLookupPort {
  getProjectExecutionContext(projectId: string): Promise<ProjectExecutionContext | null>;
  getOutcomeSnapshot(workspaceId: string, outcomeId: string): Promise<OutcomeReferenceSnapshot | null>;
}
