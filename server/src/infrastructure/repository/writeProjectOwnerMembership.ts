import type { ProjectOwnerMembershipWriter } from "@compass/direction";
import { asApplicationTransaction } from "../../bootstrap/database/contextDatabase.ts";

/**
 * Project作成者の初期owner Membership（Accessのtable）を、Directionが開いたProject作成のtransactionで書く。
 * 存在しないHumanはFK違反で例外になり、Projectもrollbackされる。
 */
export const writeProjectOwnerMembership: ProjectOwnerMembershipWriter = async (transaction, input) => {
  await asApplicationTransaction(transaction).insertInto("project_membership").values({
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
