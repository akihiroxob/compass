import { randomUUID } from "node:crypto";
import { ActivityScope } from "../domain/Activity.ts";
import type { ActivityStore, NewActivity } from "./port/ActivityStore.ts";

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

/** 既存のdedupe keyを保ち、同じProject archiveを重複記録しない。 */
export const canonicalProjectActivity = (change: ProjectChangeFact, newId: () => string = randomUUID): NewActivity => {
  const title =
    change.title.length > maximumSummaryTitleLength ? `${change.title.slice(0, maximumSummaryTitleLength)}…` : change.title;
  // archiveの理由は経緯なので本文に残す。
  const reason = change.reason?.trim() ? change.reason.trim() : null;
  return {
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
  };
};

/** Project archiveと同じtransactionのstoreに追記する。 */
export const recordCanonicalProjectActivity = async (store: ActivityStore, change: ProjectChangeFact, newId?: () => string): Promise<void> => {
  await store.append(canonicalProjectActivity(change, newId));
};
