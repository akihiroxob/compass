import type { Kysely, Transaction } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";

/** Projectの重要な状態変更。Project・Repository・Resourceの編集は対象外。 */
export type ProjectChangeNotice = {
  type: "project_archived";
  projectId: string;
  /** 所属Workspace。 */
  workspaceId: string;
  /** 人が読む対象名（Project名）。 */
  title: string;
  /** archiveの理由。 */
  reason: string;
  occurredAt: number;
};

/**
 * 状態変更を、同じtransactionでOrganizationの外へ通知する（例: canonical Activityの生成）。serverが配線する。
 * 通知先の失敗は呼び出し元の状態変更ごと巻き戻る。
 */
export type ProjectChangeObserver = (
  executor: Kysely<OrganizationDatabase> | Transaction<OrganizationDatabase>,
) => (notice: ProjectChangeNotice) => Promise<void>;
