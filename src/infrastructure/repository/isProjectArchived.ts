import type { Kysely, Transaction } from "kysely";
import type { Database } from "../database/schema.ts";

/**
 * 書込と同一transactionの中でProjectがarchivedか確認する。use caseの事前確認だけでは、
 * 確認と書込の間に入ったarchiveを検出できない。Projectが無い場合はfalse（存在の扱いは各操作に任せる）。
 */
export const isProjectArchived = async (
  database: Kysely<Database> | Transaction<Database>,
  projectId: string,
): Promise<boolean> => {
  const row = await database
    .selectFrom("project")
    .select("status")
    .where("id", "=", projectId)
    .executeTakeFirst();
  return row?.status === "archived";
};
