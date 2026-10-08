/**
 * Compass Server の `get_orchestration_state` が返す現在状態。Orchestrator は Server と MCP だけで接続する独立した
 * 実行システムなので、Server の package を import せず、公開応答の形をここで受ける。
 */
export type OrchestrationResearchRequest = {
  id: string;
  kind: string;
  status: string;
  originIntentId: string | null;
  originOutcomeId: string | null;
  updatedAt: number;
};

export type OrchestrationOutcome = {
  id: string;
  status: string;
  updatedAt: number;
  work: { state: string; storyCount: number; taskCount: number } | null;
  execution: { state: string; executionCursor: number } | null;
  /** 全Target Projectから見た評価可能性。`evaluable`以外ではEvaluatorを起動しない。 */
  evaluability: { status: string; unfinishedTargets: { projectId: string; projectStatus: string; reason: string }[] };
  latestEvaluation: { id: string; executionCursor: number; decisionId: string | null; createdAt: number } | null;
};

export type OrchestrationState = {
  project: { id: string; name: string; status: string };
  activeIntent: { id: string; status: string; updatedAt: number } | null;
  outcomes: OrchestrationOutcome[];
  intentResearchRequests: OrchestrationResearchRequest[];
  openResearchRequests: OrchestrationResearchRequest[];
  observedAt: number;
};
