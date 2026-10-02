import type { Transaction } from "kysely";
import type { AccessDatabase } from "./schema.ts";

/**
 * Project作成者の初期owner Membershipを、呼出し側（DirectionのProject作成）が開いたtransactionで書く。
 * 存在しないHumanはFK違反で例外になり、Projectもrollbackされる。serverがDirectionのwriter portへ配線する。
 */
export const writeProjectOwnerMembership = async (
  transaction: Transaction<AccessDatabase>,
  input: { projectId: string; ownerHumanUserId: string; createdAt: number },
): Promise<void> => {
  await transaction.insertInto("project_membership").values({
    id: crypto.randomUUID(),
    project_id: input.projectId,
    human_user_id: input.ownerHumanUserId,
    role: "owner",
    created_at: input.createdAt,
    updated_at: input.createdAt,
    created_by_human_user_id: input.ownerHumanUserId,
    revoked_at: null,
    revoked_by_human_user_id: null,
  }).execute();
};
