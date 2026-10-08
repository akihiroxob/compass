import { randomUUID } from "node:crypto";
import { ActivityScope, type ActivityReference } from "../domain/Activity.ts";
import type { ActivityStore } from "./port/ActivityStore.ts";

/**
 * Directionの重要な状態変更。ActivityはDirectionに依存しないため、serverがDirectionの通知からこの形へ変換して渡す。
 * `principalId`・`role`は操作した主体（Directionが来歴に持たない変更ではserverが操作Contextから補う）。
 */
export type DirectionChangeFact = {
  type: string;
  /** Project IDからの解決はserverで行い、ここにはWorkspace IDを直接渡す。 */
  workspaceId: string;
  /** 変更されたrecordのID。同じ種類の変更はrecordごとに1回で、重複生成の判定に使う。 */
  recordId: string;
  title: string;
  refs: { kind: "intent" | "outcome" | "research_request" | "decision"; id: string }[];
  result: string | null;
  reason: string | null;
  principalId: string;
  role: string;
  occurredAt: number;
};

/**
 * canonical Activityにする状態変更と、その種別・要約。Intent・Outcomeの文言編集、Research結果・Synthesisの登録、
 * ADR・Execution Evidenceの記録は、それぞれのrecordを正とし対象外とする。
 */
const directionActivities: Record<string, { type: string; summary: (title: string, result: string | null) => string }> = {
  intent_created: { type: "intent.created", summary: (title) => `Intent「${title}」を作成した` },
  intent_abandoned: { type: "intent.abandoned", summary: (title) => `Intent「${title}」を放棄した` },
  outcome_confirmed: { type: "outcome.confirmed", summary: (title) => `Outcome「${title}」を確定した` },
  outcome_cancelled: { type: "outcome.canceled", summary: (title) => `Outcome「${title}」を取り消した` },
  research_requested: { type: "research.requested", summary: (title) => `Research「${title}」を依頼した` },
  research_closed: { type: "research.closed", summary: (title, result) => `Research「${title}」を${result}で終了した` },
  decision_recorded: { type: "decision.recorded", summary: (title, result) => `Direction Decision（${result}）「${title}」を記録した` },
  outcome_evaluated: { type: "outcome.evaluated", summary: (title, result) => `Outcome「${title}」を評価した（${result}）` },
};

export const canonicalDirectionChangeTypes = Object.keys(directionActivities);

const maximumSummaryTitleLength = 200;

const textOf = (value: string | null): string | null => (value?.trim() ? value.trim() : null);

/**
 * 重要なDirectionの状態変更から、canonical Activityを追記する。状態変更と同じtransactionのstoreで呼ぶ。
 * 変更されたrecordと種類で一意にするため、同じ変更から2件作られない。対象外の変更では何もしない。
 */
export const recordCanonicalDirectionActivity = async (
  store: ActivityStore,
  change: DirectionChangeFact,
  newId: () => string = randomUUID,
): Promise<void> => {
  const definition = directionActivities[change.type];
  if (!definition) return;
  const title =
    change.title.length > maximumSummaryTitleLength ? `${change.title.slice(0, maximumSummaryTitleLength)}…` : change.title;
  const refs: ActivityReference[] = change.refs.map(({ kind, id }) => ({ kind, id }));
  // 取消・放棄・判断の理由は経緯なので本文に残す。その他の詳細は各recordを正とし、複製しない。
  const reason = textOf(change.reason);
  await store.append({
    id: newId(),
    scope: ActivityScope.WORKSPACE,
    workspaceId: change.workspaceId,
    projectId: null,
    type: definition.type,
    principalId: change.principalId,
    role: change.role,
    summary: definition.summary(title, change.result),
    body: reason ? `理由: ${reason}` : null,
    refs,
    correctsActivityId: null,
    source: "canonical",
    occurredAt: change.occurredAt,
    recordedAt: change.occurredAt,
    dedupeKey: `direction_change:${change.type}:${change.recordId}`,
    inputHash: null,
  });
};
