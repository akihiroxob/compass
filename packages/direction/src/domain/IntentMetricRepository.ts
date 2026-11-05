import type { IntentStatus } from "./Intent.ts";
import type { IntentMetric, IntentMetricObservation, IntentMetricObservationStatus, IntentMetricSource } from "./IntentMetric.ts";
import type { WorkspaceArchivedResult } from "./WorkspaceArchivedResult.ts";

/** 検証済みの観測項目の定義。検証規則（zod schema）はapplication層が持つ。 */
export type DefineIntentMetricInput = {
  key: string;
  name: string;
  unit: string;
  targetValue: number | null;
  staleAfterDays: number;
};

/** 検証済みの観測値1件。`observed`は値あり、`failed`は値なし・理由ありであることをschemaが保証する。 */
export type IntentMetricObservationInput = {
  periodStart: string;
  periodEnd: string;
  status: IntentMetricObservationStatus;
  value: number | null;
  failureReason: string | null;
  source: IntentMetricSource;
  observedAt: number;
};

/** 対象Intentが書込できない理由。Workspaceのarchiveは他の検査より先に返す（同一transaction）。 */
type IntentMetricWriteRejection =
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | WorkspaceArchivedResult;

export type DefineIntentMetricResult =
  | { kind: "created" | "updated" | "unchanged"; metric: IntentMetric }
  /** 観測値がある項目の単位は変更できない。 */
  | { kind: "unit_locked"; unit: string }
  | IntentMetricWriteRejection;

/** 観測値1件の記録結果。`unchanged`は同じ対象期間の最新版と同じ内容の再送で、新しい版を作らない。 */
export type IntentMetricObservationRecord = {
  kind: "created" | "revised" | "unchanged";
  observation: IntentMetricObservation;
};

export type RecordIntentMetricObservationsResult =
  | { kind: "recorded"; metric: IntentMetric; observations: IntentMetricObservationRecord[] }
  | { kind: "metric_not_found" }
  | IntentMetricWriteRejection;

export type IntentMetricSeriesRange = { from: string; to: string };

export type IntentMetricWithObservations = {
  metric: IntentMetric;
  /** 最新の対象期間の最新版（取得失敗を含む）。 */
  latest: IntentMetricObservation | null;
  /** 値を取得できた最新の観測（各対象期間の最新版に限る）。 */
  lastObserved: IntentMetricObservation | null;
  /** 範囲と重なる対象期間の最新版。対象期間の開始順。観測の無い期間は含めない。 */
  series: IntentMetricObservation[];
};

export interface IntentMetricRepository {
  define(workspaceId: string, intentId: string, principalId: string, input: DefineIntentMetricInput, at: number): Promise<DefineIntentMetricResult>;
  recordObservations(
    workspaceId: string,
    intentId: string,
    metricKey: string,
    principalId: string,
    observations: IntentMetricObservationInput[],
    at: number,
  ): Promise<RecordIntentMetricObservationsResult>;
  /** Intentの観測項目（作成順）と、各項目の最新・範囲内の観測。IntentがWorkspaceに無ければnull。 */
  listByIntent(workspaceId: string, intentId: string, range: IntentMetricSeriesRange): Promise<IntentMetricWithObservations[] | null>;
}
