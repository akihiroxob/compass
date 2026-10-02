import type {
  CriterionEvaluation,
  EvaluationResult,
  EvaluationSnapshot,
  OutcomeEvaluation,
} from "../model/OutcomeEvaluation.ts";
import type { IntentStatus } from "../model/Intent.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";

/** 再送の同一性を判定する、Evaluatorが指定した内容。snapshotと導出した結果は含めない（再送のたびに変わり得るため）。 */
export type OutcomeEvaluationRequest = {
  outcomeId: string;
  requestKey: string;
  runRef: string;
  criteria: readonly { criterionId: string; verdict: string; rationale: string; evidenceIds: readonly string[] }[];
  principalId: string;
};

export type RecordOutcomeEvaluationInput = {
  request: OutcomeEvaluationRequest;
  intentId: string;
  result: EvaluationResult;
  criteria: readonly CriterionEvaluation[];
  snapshot: EvaluationSnapshot;
  at: number;
};

export type FindEvaluationReplayResult =
  | { kind: "none" }
  | { kind: "replayed"; evaluation: OutcomeEvaluation }
  | { kind: "key_conflict"; requestKey: string };

export type RecordOutcomeEvaluationResult =
  | { kind: "created"; evaluation: OutcomeEvaluation }
  | { kind: "replayed"; evaluation: OutcomeEvaluation }
  | { kind: "key_conflict"; requestKey: string }
  /** 評価対象OutcomeのIntentがactiveでない（達成済み・中止）。 */
  | { kind: "intent_not_active"; status: IntentStatus }
  | ProjectArchivedResult;

/**
 * Direction所有のOutcome Evaluation。追記だけで、更新・削除するメソッドは意図的に持たない。
 * Outcome・Success Criterion・Execution側のtableは変更しない。
 */
export interface OutcomeEvaluationRepository {
  /** 同じProject・requestKeyの評価があれば、内容が同じなら再送、違えば競合として返す。 */
  findReplay(projectId: string, request: OutcomeEvaluationRequest): Promise<FindEvaluationReplayResult>;
  /**
   * 1 transactionで再送を確認し、なければ評価と`outcome_evaluated` Runtimeイベントを保存する。
   * archivedなProject・activeでないIntentには保存しない。同じrequestKeyの並行した再送も、1件に収束させる。
   */
  record(projectId: string, input: RecordOutcomeEvaluationInput): Promise<RecordOutcomeEvaluationResult>;
  /** Outcomeの評価を新しい順に返す。 */
  findByOutcome(projectId: string, outcomeId: string): Promise<OutcomeEvaluation[]>;
  /** Intent配下の各Outcomeの最新の評価を、新しい順に返す。 */
  findLatestByIntent(projectId: string, intentId: string): Promise<OutcomeEvaluation[]>;
}
