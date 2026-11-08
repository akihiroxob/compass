import type { OutcomeProjectRef } from "./ExecutionSummaryPort.ts";

/** 公開確認の判定（Workの公開確認の定義と同じ語彙）。`unconfirmed`は公開済み・未公開のどちらにも分類しない。 */
export type OutcomeChangePublicationStatus = "published" | "not_published" | "unconfirmed";

/** 公開確認を入力元（`publication:write`のRuntime Credential）も記録もなく確認できない場合の理由。 */
export type OutcomeChangeUnconfirmedReason = "not_configured" | "no_revision" | "no_record" | "not_compared";

/** Outcomeに相関付いたStoryのTaskのうち、公開確認の対象になる変更（PR登録または受入成果物あり）1件。 */
export type OutcomeDeliveryChange = {
  taskId: string;
  status: OutcomeChangePublicationStatus;
  reason: OutcomeChangeUnconfirmedReason | null;
};

/** Target Project 1件・Outcome 1件の公開確認。`changes`が`null`なら、そのProjectの公開確認を取得できなかった（変更なしではない）。 */
export type OutcomeProjectDelivery = {
  outcomeId: string;
  projectId: string;
  changes: OutcomeDeliveryChange[] | null;
};

/**
 * Direction → Workの読取専用ポート。Workの既存の公開確認（リリース履歴）から、Target ProjectのOutcome相関Storyの変更の公開状況を返す。
 * Task受入・PRのmerge・還流を公開として扱わず、公開の判定はWorkの公開記録だけに従う。
 */
export interface OutcomeDeliveryPort {
  listOutcomeDeliveries(refs: OutcomeProjectRef[]): Promise<OutcomeProjectDelivery[]>;
}
