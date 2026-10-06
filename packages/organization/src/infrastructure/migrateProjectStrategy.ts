import type { Kysely, Transaction } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";
import { replaceWorkspaceOrderedValues, writeWorkspace } from "./writeWorkspace.ts";

const legacyOrderedValues = async (
  transaction: Transaction<OrganizationDatabase>,
  table: "project_principle" | "project_constraint",
  projectId: string,
): Promise<string[]> => {
  const rows = await transaction.selectFrom(table).select("value")
    .where("project_id", "=", projectId).orderBy("sort_order").execute();
  return rows.map(({ value }) => value);
};

/**
 * 1件のProjectの旧列の戦略値（name・Mission・Vision・Principles・Constraints）と状態を、所属Workspaceへ写す。
 * 未所属ならWorkspaceを作って所属させ、所属済み（旧列を正本としていた間に1対1で作ったWorkspace）なら現在値で上書きする。
 * archive済みProjectのWorkspaceはarchivedにする（activeのまま残すとarchive済みProjectだけのWorkspaceへ新規活動を許すため）。
 * 最後に`strategy_migrated_at`を設定し、以後は旧列を読まない。
 */
const migrateProjectStrategy = async (transaction: Transaction<OrganizationDatabase>, projectId: string): Promise<void> => {
  const project = await transaction.selectFrom("project").selectAll()
    .where("id", "=", projectId).where("strategy_migrated_at", "is", null).executeTakeFirst();
  if (!project) return;
  const [principles, constraints] = await Promise.all([
    legacyOrderedValues(transaction, "project_principle", projectId),
    legacyOrderedValues(transaction, "project_constraint", projectId),
  ]);
  const values = {
    name: project.name,
    mission: project.mission,
    vision: project.vision,
    updatedAt: project.updated_at,
    status: project.status,
    archivedAt: project.archived_at,
    archiveReason: project.archive_reason,
  };

  let workspaceId = project.workspace_id;
  if (workspaceId === null) {
    workspaceId = crypto.randomUUID();
    await writeWorkspace(transaction, { id: workspaceId, ...values, principles, constraints, createdAt: project.created_at });
  } else {
    await transaction
      .updateTable("workspace")
      .set({
        name: values.name,
        mission: values.mission,
        vision: values.vision,
        updated_at: values.updatedAt,
        status: values.status,
        archived_at: values.archivedAt,
        archive_reason: values.archiveReason,
      })
      .where("id", "=", workspaceId)
      .execute();
    await replaceWorkspaceOrderedValues(transaction, "workspace_principle", workspaceId, principles);
    await replaceWorkspaceOrderedValues(transaction, "workspace_constraint", workspaceId, constraints);
  }
  const result = await transaction
    .updateTable("project")
    .set({ workspace_id: workspaceId, strategy_migrated_at: Date.now() })
    .where("id", "=", projectId)
    .where("strategy_migrated_at", "is", null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error(`Project ${projectId} was migrated concurrently`);
};

/**
 * 戦略値の正本をProjectの旧列からWorkspaceへ移す（非破壊の移行。docs/workspace-migration-impact-map.md）。
 * 対象は`strategy_migrated_at`がnullのProject（Workspace導入前のProjectと、導入後・正本切替前に旧列へ書かれたProject）。
 * Project 1件ごとのtransactionで行うため、再起動・再実行・途中失敗後の再実行でも重複・二重上書きしない。
 * 旧列・旧table、Project ID・Story / Task・Grant・Credential・Change Log・Activity等の既存行は書き換えない。
 */
export const migrateProjectStrategyToWorkspaces = async (database: Kysely<OrganizationDatabase>): Promise<void> => {
  const projects = await database
    .selectFrom("project")
    .select("id")
    .where("strategy_migrated_at", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  for (const { id } of projects) {
    await database.transaction().execute((transaction) => migrateProjectStrategy(transaction, id));
  }
};
