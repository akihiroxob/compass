import type { Transaction } from "kysely";
import type { WorkspaceProperties } from "../domain/Workspace.ts";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * Workspaceと子（Principles / Constraints）を、渡されたtransactionで書く。並び順は配列の順とする。
 * 既存Projectからの移行・Project作成と同じtransactionでの割当（serverの配線）でも使い、Organizationのtableを他Contextに触らせない。
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
