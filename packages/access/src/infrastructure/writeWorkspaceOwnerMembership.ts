import type { Transaction } from "kysely";
import type { AccessDatabase } from "./schema.ts";

/**
 * Workspace作成者の初期owner Membershipを、呼出し側（OrganizationのWorkspace・Project作成）が開いたtransactionで書く。
 * 存在しないHumanはFK違反で例外になり、Workspaceもrollbackされる。serverがOrganizationのwriter portへ配線する。
 */
export const writeWorkspaceOwnerMembership = async (
  transaction: Transaction<AccessDatabase>,
  input: { workspaceId: string; ownerHumanUserId: string; createdAt: number },
): Promise<void> => {
  await transaction.insertInto("workspace_membership").values({
    id: crypto.randomUUID(),
    workspace_id: input.workspaceId,
    human_user_id: input.ownerHumanUserId,
    role: "owner",
    created_at: input.createdAt,
    updated_at: input.createdAt,
    created_by_human_user_id: input.ownerHumanUserId,
    revoked_at: null,
    revoked_by_human_user_id: null,
  }).execute();
};
