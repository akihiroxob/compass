import type { Kysely } from "kysely";
import type { AccessDatabase } from "@compass/access";
import type { D1OwnerMembershipPlanner } from "./D1WorkspaceRepository.ts";

/** Access所有の初期MembershipをSQLとして渡し、Workspace作成と同じD1 batchへ参加させる。 */
export const planD1WorkspaceOwnerMembership = (database: Kysely<AccessDatabase>): D1OwnerMembershipPlanner =>
  ({ workspaceId, ownerHumanUserId, createdAt }) => [database.insertInto("workspace_membership").values({
    id: crypto.randomUUID(), workspace_id: workspaceId, human_user_id: ownerHumanUserId,
    role: "owner", created_at: createdAt, updated_at: createdAt, created_by_human_user_id: ownerHumanUserId,
    revoked_at: null, revoked_by_human_user_id: null,
  }).compile()];
