/** Executionが導出する、Outcomeに相関付いたStory / Taskの結果区分。 */
export type ExecutionSummaryState = "accepted" | "rejected" | "canceled" | "incomplete";

export type ExecutionSummaryTaskCounts = {
  todo: number;
  doing: number;
  in_review: number;
  wait_accept: number;
  accepted: number;
  rejected: number;
  canceled: number;
};

export type ExecutionStorySummary = {
  storyId: string;
  /** Storyの`status`（todo / doing / done / canceled）。 */
  status: string;
  state: ExecutionSummaryState;
  taskCounts: ExecutionSummaryTaskCounts;
};

/**
 * ExecutionのStory / Task / Change Logから導出した、Outcome単位の結果。Story・Task・Commentの本文は含まない。
 * 導出のたびにその時点のExecution状態から計算するため、通知の順序や重複に結果が左右されない。
 */
export type ExecutionSummarySnapshot = {
  outcomeId: string;
  /** DirectionがExecutionへ渡す相関ID（`outcome:{outcomeId}`）。 */
  correlationId: string;
  state: ExecutionSummaryState;
  stories: ExecutionStorySummary[];
  /** このOutcomeのStory・Taskに関する最新のChange Log cursor。 */
  latestChangeCursor: number;
  /** Project全体のChange Logの最新cursor。Runtimeが報告するcursorがこれを超えていれば捏造として拒否する。 */
  headChangeCursor: number;
};

/**
 * Direction → Executionの読取専用ポート。DirectionはExecutionのRepository・tableを直接使わず、
 * Evidence還流のときだけこのポートを通してOutcomeの結果を取得する。書込メソッドは意図的に持たない。
 * Outcomeに相関付いたStoryが無い場合は、Projectまたぎ・未着手を区別せずnull。
 */
export interface ExecutionSummaryPort {
  getOutcomeExecutionSummary(projectId: string, outcomeId: string): Promise<ExecutionSummarySnapshot | null>;
}

/** Outcomeと、そのWorkを持ちうるProjectの組。 */
export type OutcomeProjectRef = { outcomeId: string; projectId: string };

/** 1組のWorkの要約。Story / Taskの本文・IDは含めず、状態と件数だけを返す。 */
export type OutcomeProjectWorkSummary = OutcomeProjectRef & {
  state: ExecutionSummaryState;
  storyCount: number;
  /** 組に相関付いた全StoryのTaskの状態別件数。 */
  taskCounts: ExecutionSummaryTaskCounts;
};

/**
 * Direction → Workの読取専用ポート（Target別の表示・dispatch用）。各組について、そのProjectのStoryのうち
 * Outcomeへ相関付いたもの（`outcome_ref`）だけを数え、他Projectの同じOutcomeのStoryを混ぜない。
 * 組の数によらず一定回数の読取で返す。Storyが無い組は結果に含めない。書込メソッドは持たない。
 */
export interface OutcomeWorkSummaryPort {
  summarizeOutcomeProjects(refs: OutcomeProjectRef[]): Promise<OutcomeProjectWorkSummary[]>;
}
