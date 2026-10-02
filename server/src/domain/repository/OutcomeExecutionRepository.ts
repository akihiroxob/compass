import type {
  ExecutionEvidenceKind,
  ExecutionState,
  ExecutionStoryResult,
  OutcomeExecutionRecord,
} from "../model/OutcomeExecution.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";

export type RecordOutcomeExecutionInput = {
  outcomeId: string;
  correlationId: string;
  state: ExecutionState;
  stories: readonly ExecutionStoryResult[];
  /** Execution側から導出した、このOutcomeの最新Change cursor。 */
  executionCursor: number;
  /** Runtimeが報告したChange cursor。 */
  changeCursor: number;
  evidence: readonly {
    kind: ExecutionEvidenceKind;
    uri: string;
    versionHash: string | null;
    observedAt: number;
  }[];
  principalId: string;
  at: number;
};

export type RecordOutcomeExecutionResult =
  | {
      kind: "recorded";
      record: OutcomeExecutionRecord;
      /** 要約を新規作成または更新した。同じ内容の再送・古い通知ではfalse。 */
      summaryChanged: boolean;
      /** Runtimeが報告したcursorが、保存済みの報告より古かった（順序逆転した通知）。状態は巻き戻さない。 */
      staleInput: boolean;
      evidenceAdded: number;
    }
  | { kind: "evidence_limit_exceeded"; limit: number }
  | ProjectArchivedResult;

/**
 * Direction側のOutcomeへ、Executionの結果の要約とEvidence参照を相関付けて保存する。
 * Executionのtable・Repositoryは使わない（要約はポート経由で受け取った値）。
 */
export interface OutcomeExecutionRepository {
  /**
   * 1 transactionで、要約を「Execution cursorが進むときだけ」上書きし、Evidenceを`(Outcome, kind, uri, versionHash)`で
   * 重複なく追記する。同じ入力の再送は何も増やさない。
   */
  record(projectId: string, input: RecordOutcomeExecutionInput): Promise<RecordOutcomeExecutionResult>;
  /** まだ還流されていないOutcomeはnull。 */
  find(projectId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null>;
}
