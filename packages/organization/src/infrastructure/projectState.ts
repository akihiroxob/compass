import type { Kysely, Transaction } from "kysely";
import type { OrganizationDatabase } from "./schema.ts";

/**
 * 他Context（Direction・Work・Access・Activity）が、自身の書込と同一transactionで読むProject・Workspaceの状態。
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

/** 指定したProjectのうちarchivedのもの。一覧の参照モデルがProjectごとに読まないよう1回で読む。 */
export const findArchivedProjectIds = async (database: Queryable, projectIds: string[]): Promise<Set<string>> => {
  if (projectIds.length === 0) return new Set();
  const rows = await database
    .selectFrom("project")
    .select("id")
    .where("id", "in", projectIds)
    .where("status", "=", "archived")
    .execute();
  return new Set(rows.map(({ id }) => id));
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

/** 書込と同一transactionの中でWorkspaceがarchivedか確認する。Workspaceが無い場合はfalse。 */
export const isWorkspaceArchived = async (database: Queryable, workspaceId: string): Promise<boolean> => {
  const row = await database
    .selectFrom("workspace")
    .select("status")
    .where("id", "=", workspaceId)
    .executeTakeFirst();
  return row?.status === "archived";
};

/** active / archivedを問わず、作成順のWorkspace ID（Accessの初期Membershipの補完が使う）。 */
export const listWorkspaceIdsInCreationOrder = async (database: Queryable): Promise<string[]> => {
  const rows = await database.selectFrom("workspace").select("id").orderBy("created_at").orderBy("id").execute();
  return rows.map(({ id }) => id);
};

/** Workspaceに所属するProjectのID（active / archivedを問わず作成順）。 */
export const listWorkspaceProjectIds = async (database: Queryable, workspaceId: string): Promise<string[]> => {
  const rows = await database
    .selectFrom("project")
    .select("id")
    .where("workspace_id", "=", workspaceId)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  return rows.map(({ id }) => id);
};

/** Projectの所属Workspace ID。存在・所属の欠損はnull。呼出し元のtransactionのまま読む。 */
export const findProjectWorkspaceId = async (database: Queryable, projectId: string): Promise<string | null> => {
  const row = await database.selectFrom("project").select("workspace_id").where("id", "=", projectId).executeTakeFirst();
  return row?.workspace_id ?? null;
};

/** Workspaceの状態。存在しなければnull。呼出し元のtransactionのまま読む。 */
export const findWorkspaceStatus = async (database: Queryable, workspaceId: string): Promise<"active" | "archived" | null> => {
  const row = await database.selectFrom("workspace").select("status").where("id", "=", workspaceId).executeTakeFirst();
  return row?.status ?? null;
};

/** Workspaceに所属するProject（active / archivedを問わない）に登録されたRepository・ResourceのID。 */
export const listWorkspaceProjectResourceIds = async (database: Queryable, workspaceId: string): Promise<string[]> => {
  const [repositories, resources] = await Promise.all([
    database
      .selectFrom("project_repository_link")
      .innerJoin("project", "project.id", "project_repository_link.project_id")
      .select("project_repository_link.id")
      .where("project.workspace_id", "=", workspaceId)
      .execute(),
    database
      .selectFrom("project_resource")
      .innerJoin("project", "project.id", "project_resource.project_id")
      .select("project_resource.id")
      .where("project.workspace_id", "=", workspaceId)
      .execute(),
  ]);
  return [...repositories, ...resources].map(({ id }) => id);
};
