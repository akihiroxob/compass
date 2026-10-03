import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "./schema.ts";

/**
 * Directionの重要な状態変更。編集（Intent・Outcomeの文言変更）、Research結果・Synthesisの登録、ADR・Evidenceの記録は
 * 個別のrecordやRuntime eventを正とし、ここへは含めない。
 */
export type DirectionChangeType =
  | "intent_created"
  | "intent_abandoned"
  | "outcome_confirmed"
  | "outcome_cancelled"
  | "research_requested"
  | "research_closed"
  | "decision_recorded"
  | "outcome_evaluated"
  | "project_archived";

/** 状態変更が関わるDirectionのEntity。 */
export type DirectionChangeRef = { kind: "intent" | "outcome" | "research_request" | "decision"; id: string };

export type DirectionChangeNotice = {
  type: DirectionChangeType;
  projectId: string;
  /** 変更されたrecord（Intent・Outcome・Request・Decision・Evaluation・Project）のID。同じ種類の変更はrecordごとに1回。 */
  recordId: string;
  /** 人が読む対象名（Intent・Outcomeのtitle、Researchのquestion、Project名等）。 */
  title: string;
  refs: DirectionChangeRef[];
  /** 結論（Researchの終了状態・Decisionの種類・Evaluationの総合結果）。 */
  result: string | null;
  /** 取消・放棄・停止・archiveの理由。 */
  reason: string | null;
  /** Directionが来歴として保存しているPrincipal（Decision・Evaluation）。保存しない変更はnull。 */
  principalId: string | null;
  occurredAt: number;
};

/**
 * 状態変更を、同じtransactionでDirectionの外へ通知する（例: canonical Activityの生成）。serverが配線する。
 * 通知先の失敗は呼び出し元の状態変更ごと巻き戻る。
 */
export type DirectionChangeObserver = (
  executor: Kysely<DirectionDatabase> | Transaction<DirectionDatabase>,
) => (notice: DirectionChangeNotice) => Promise<void>;

export const notifyDirectionChange = async (
  observer: DirectionChangeObserver | null,
  transaction: Transaction<DirectionDatabase>,
  notice: DirectionChangeNotice,
): Promise<void> => {
  if (observer) await observer(transaction)(notice);
};
