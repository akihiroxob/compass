import type { Transaction } from "kysely";
import type { WorkspaceProperties } from "../domain/Workspace.ts";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * Workspaceと子（Principles / Constraints）を、渡されたtransactionで書く。並び順は配列の順とする。
 * Workspaceの作成・Project作成と同じtransactionでの作成・既存Projectからの移行で使う。
 */
export const writeWorkspace = async (
  transaction: Transaction<OrganizationDatabase>,
  workspace: WorkspaceProperties,
): Promise<void> => {
  await transaction
    .insertInto("workspace")
    .values({
      id: workspace.id,
      name: workspace.name,
      mission: workspace.mission,
      vision: workspace.vision,
      created_at: workspace.createdAt,
      updated_at: workspace.updatedAt,
      status: workspace.status,
      archived_at: workspace.archivedAt,
      archive_reason: workspace.archiveReason,
    })
    .execute();
  for (const [table, values] of [
    ["workspace_principle", workspace.principles],
    ["workspace_constraint", workspace.constraints],
  ] as const) {
    if (!values.length) continue;
    await transaction.insertInto(table).values(
      values.map((value, sortOrder) => ({
        id: crypto.randomUUID(), workspace_id: workspace.id, value, sort_order: sortOrder,
      })),
    ).execute();
  }
};

/** WorkspaceのPrinciples / Constraintsを、渡されたtransactionで全置換する。並び順は配列の順とする。 */
export const replaceWorkspaceOrderedValues = async (
  transaction: Transaction<OrganizationDatabase>,
  table: "workspace_principle" | "workspace_constraint",
  workspaceId: string,
  values: string[],
): Promise<void> => {
  await transaction.deleteFrom(table).where("workspace_id", "=", workspaceId).execute();
  if (!values.length) return;
  await transaction.insertInto(table).values(
    values.map((value, sortOrder) => ({
      id: crypto.randomUUID(), workspace_id: workspaceId, value, sort_order: sortOrder,
    })),
  ).execute();
};
