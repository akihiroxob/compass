import { randomUUID } from "node:crypto";
import { ActivityScope } from "../domain/Activity.ts";
import type { ActivityStore } from "./port/ActivityStore.ts";

/**
 * Project（Organizationが所有）の重要な状態変更。ActivityはOrganizationに依存しないため、serverが通知からこの形へ変換して渡す。
 * `principalId`・`role`は操作した主体（serverが操作Contextから補う）。
 */
export type ProjectChangeFact = {
  type: "project_archived";
  workspaceId: string;
  projectId: string;
  title: string;
  reason: string | null;
  principalId: string;
  role: string;
  occurredAt: number;
};

const maximumSummaryTitleLength = 200;

/**
 * Projectのarchiveから、project scopeのcanonical Activityを追記する。状態変更と同じtransactionのstoreで呼ぶ。
 * 一意キーはDirectionが通知していた時期と同じ（`direction_change:project_archived:{projectId}`）にし、移設の前後で重複させない。
 */
export const recordCanonicalProjectActivity = async (
  store: ActivityStore,
  change: ProjectChangeFact,
  newId: () => string = randomUUID,
): Promise<void> => {
  const title =
    change.title.length > maximumSummaryTitleLength ? `${change.title.slice(0, maximumSummaryTitleLength)}…` : change.title;
  // archiveの理由は経緯なので本文に残す。
  const reason = change.reason?.trim() ? change.reason.trim() : null;
  await store.append({
    id: newId(),
    scope: ActivityScope.PROJECT,
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    type: "project.archived",
    principalId: change.principalId,
    role: change.role,
    summary: `Project「${title}」をarchiveした`,
    body: reason ? `理由: ${reason}` : null,
    refs: [],
    correctsActivityId: null,
    source: "canonical",
    occurredAt: change.occurredAt,
    recordedAt: change.occurredAt,
    dedupeKey: `direction_change:${change.type}:${change.projectId}`,
    inputHash: null,
  });
};
