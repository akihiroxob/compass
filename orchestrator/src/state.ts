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

/**
 * Compass Server の `get_workspace_orchestration_state` が返す、Outcome の Target 1件の現在状態。archived の Project も
 * `projectStatus` 付きで残る。`work` はその Project で Outcome に相関付いた Story / Task の件数（Story が無ければ null）、
 * `execution` はその Project から還流済みの Execution 要約（未還流は null）。
 */
export type WorkspaceOrchestrationTarget = {
  projectId: string;
  projectStatus: string;
  work: { state: string; storyCount: number; taskCount: number } | null;
  execution: { state: string; executionCursor: number } | null;
};

export type WorkspaceOrchestrationOutcome = {
  id: string;
  status: string;
  updatedAt: number;
  /** 現在の Target（設定順）。空なら Target なし。 */
  targets: WorkspaceOrchestrationTarget[];
  /** 全 Target から見た評価可能性（`evaluable` / `no_targets` / `replan_required` / `awaiting_execution`）。 */
  evaluability: { status: string; unfinishedTargets: { projectId: string; projectStatus: string; reason: string }[] };
  /** 最新 Evaluation。`targets` は評価 snapshot にあった Project 別の Execution cursor。 */
  latestEvaluation: {
    id: string;
    decisionId: string | null;
    createdAt: number;
    targets: { projectId: string; executionCursor: number }[];
  } | null;
};

/** Compass Server の `get_workspace_orchestration_state` が返す1 Workspace の現在状態。ID・状態・件数だけで本文を含まない。 */
export type WorkspaceOrchestrationState = {
  workspace: { id: string; name: string; status: string };
  /** Workspace の active な Project。archived の Project は Target としてだけ現れる。 */
  projects: { id: string; name: string }[];
  activeIntent: { id: string; status: string; updatedAt: number } | null;
  outcomes: WorkspaceOrchestrationOutcome[];
  intentResearchRequests: OrchestrationResearchRequest[];
  openResearchRequests: OrchestrationResearchRequest[];
  observedAt: number;
};
