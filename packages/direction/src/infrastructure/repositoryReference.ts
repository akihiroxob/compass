import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "./schema.ts";

/**
 * 指定したProject RepositoryのうちADR Handoff Request/Referenceから参照されているものがあれば、そのIDを1件返す。
 * 依頼・参照は監査記録として`repository_id`をcascadeさせないため、OrganizationがRepositoryを外す前に
 * 同じtransactionで呼ぶ（serverが配線する）。
 */
export const findAdrReferencedRepositoryId = async (
  database: Kysely<DirectionDatabase> | Transaction<DirectionDatabase>,
  repositoryIds: string[],
): Promise<string | null> => {
  if (!repositoryIds.length) return null;
  const [handoffRow, referenceRow] = await Promise.all([
    database.selectFrom("adr_handoff_request").select("repository_id")
      .where("repository_id", "in", repositoryIds).executeTakeFirst(),
    database.selectFrom("adr_reference").select("repository_id")
      .where("repository_id", "in", repositoryIds).executeTakeFirst(),
  ]);
  return handoffRow?.repository_id ?? referenceRow?.repository_id ?? null;
};
