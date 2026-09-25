import type { Selectable, Transaction } from "kysely";
import { buildInitialResearchRequest, initialResearchRequestKey } from "../../domain/model/InitialResearchRequest.ts";
import type { ResearchRequest } from "../../domain/model/Research.ts";
import type { Database, IntentTable } from "../database/schema.ts";
import { insertResearchRequest, toRequest } from "./researchRequestRecord.ts";

/**
 * Active IntentのInitial Research Requestを、なければ作成し、あれば既存を返す。
 * Intentの状態検査は呼び出し側の責務（作成直後のIntent、または起動時のActive Intent走査）。
 * 既にあれば、Requestが取消・終了済みでも新しく作らない（Intentごとに1件）。
 */
export const ensureInitialResearchRequest = async (
  transaction: Transaction<Database>,
  intent: Pick<Selectable<IntentTable>, "id" | "project_id" | "title">,
  now: number,
): Promise<{ kind: "created" | "replayed"; request: ResearchRequest }> => {
  const existing = await transaction
    .selectFrom("research_request")
    .selectAll()
    .where("project_id", "=", intent.project_id)
    .where("request_key", "=", initialResearchRequestKey(intent.id))
    .executeTakeFirst();
  if (existing) return { kind: "replayed", request: toRequest(existing) };
  const request = await insertResearchRequest(
    transaction,
    intent.project_id,
    buildInitialResearchRequest({ id: intent.id, title: intent.title }),
    now,
  );
  return { kind: "created", request };
};
