import type {
  CriterionEvaluation,
  EvaluationResult,
  EvaluationSnapshot,
  OutcomeEvaluation,
} from "./OutcomeEvaluation.ts";
import type { IntentStatus } from "./Intent.ts";
import type { OutcomeStatus } from "./Outcome.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

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
  /** 評価対象のOutcomeがactiveでない（評価の入力を読んだ後に変わった）。 */
  | { kind: "outcome_not_active"; status: OutcomeStatus }
  /**
   * 評価の入力を読んだ後に、Target・Projectの状態・還流したSummary / Evidenceが変わった（またはもう評価可能でない）。
   * snapshotが現在の全Targetと一致しないため保存しない。呼出側が読み直して評価可能性から判定し直す。
   */
  | { kind: "targets_changed" }
  | WorkspaceArchivedResult;

/**
 * Direction所有のOutcome Evaluation。追記だけで、更新・削除するメソッドは意図的に持たない。
 * Outcome・Success Criterion・Execution側のtableは変更しない。
 */
export interface OutcomeEvaluationRepository {
  /** 同じWorkspace・requestKeyの評価があれば、内容が同じなら再送、違えば競合として返す。 */
  findReplay(workspaceId: string, request: OutcomeEvaluationRequest): Promise<FindEvaluationReplayResult>;
  /**
   * 1 transactionで再送を確認し、なければ評価と`outcome_evaluated` Runtimeイベントを保存する。
   * archivedなWorkspace・activeでないIntent / Outcomeには保存しない。同じtransactionで現在の全Target・Projectの状態・
   * Summary / Evidenceを読み、評価可能でsnapshotの`targets`と一致する場合だけ保存する（Target追加・解除や還流との競合で、
   * 一部のTargetだけの評価を確定させない）。同じrequestKeyの並行した再送も、1件に収束させる。
   */
  record(workspaceId: string, input: RecordOutcomeEvaluationInput): Promise<RecordOutcomeEvaluationResult>;
  /** Outcomeの評価を新しい順に返す。 */
  findByOutcome(workspaceId: string, outcomeId: string): Promise<OutcomeEvaluation[]>;
  /** Intent配下の各Outcomeの最新の評価を、新しい順に返す。 */
  findLatestByIntent(workspaceId: string, intentId: string): Promise<OutcomeEvaluation[]>;
}
