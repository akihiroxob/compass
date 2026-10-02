import type { Kysely, Transaction } from "kysely";
import type { DirectionDatabase } from "./schema.ts";

/** active / archivedを問わず、作成順のProject ID。呼出し側のtransactionのまま読む（Accessのowner補完が使う）。 */
export const listProjectIdsInCreationOrder = async (
  database: Kysely<DirectionDatabase> | Transaction<DirectionDatabase>,
): Promise<string[]> => {
  const rows = await database.selectFrom("project").select("id").orderBy("created_at").execute();
  return rows.map(({ id }) => id);
};
