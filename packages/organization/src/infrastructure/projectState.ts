import type { Kysely, Transaction } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * 他Context（Direction・Work・Access・Activity）が、自身の書込と同一transactionで読むProjectの状態。
 * 他ContextはOrganizationのtableを直接扱わず、serverがこれらの関数を同じ接続・transactionで渡す。
 */
type Queryable = Kysely<OrganizationDatabase> | Transaction<OrganizationDatabase>;

export const projectExists = async (database: Queryable, projectId: string): Promise<boolean> => {
  const row = await database.selectFrom("project").select("id").where("id", "=", projectId).executeTakeFirst();
  return row !== undefined;
};

/**
 * 書込と同一transactionの中でProjectがarchivedか確認する。use caseの事前確認だけでは、
 * 確認と書込の間に入ったarchiveを検出できない。Projectが無い場合はfalse（存在の扱いは各操作に任せる）。
 */
export const isProjectArchived = async (database: Queryable, projectId: string): Promise<boolean> => {
  const row = await database
    .selectFrom("project")
    .select("status")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return row?.status === "archived";
};

/** active / archivedを問わず、作成順のProject ID。呼出し側のtransactionのまま読む（Accessのowner補完が使う）。 */
export const listProjectIdsInCreationOrder = async (database: Queryable): Promise<string[]> => {
  const rows = await database.selectFrom("project").select("id").orderBy("created_at").execute();
  return rows.map(({ id }) => id);
};

/** Projectに登録されたRepository。他Projectのidは見つからない扱いにする。 */
export const findProjectRepository = (database: Queryable, projectId: string, repositoryId: string) =>
  database
    .selectFrom("project_repository_link")
    .select(["id", "name", "url"])
    .where("id", "=", repositoryId)
    .where("project_id", "=", projectId)
    .executeTakeFirst();

/** Projectの所属WorkspaceのConstraints（正本）。並び順を保つ。Projectが無ければ空。 */
export const findProjectWorkspaceConstraints = async (database: Queryable, projectId: string): Promise<string[]> => {
  const rows = await database
    .selectFrom("project")
    .innerJoin("workspace_constraint", "workspace_constraint.workspace_id", "project.workspace_id")
    .select("workspace_constraint.value")
    .where("project.id", "=", projectId)
    .orderBy("workspace_constraint.sort_order")
    .execute();
  return rows.map(({ value }) => value);
};
