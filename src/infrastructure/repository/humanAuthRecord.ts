import type { Selectable, Transaction } from "kysely";
import type {
  HumanIdentity,
  HumanUser,
  ProjectInvitation,
  ProjectMembership,
  WebSession,
} from "../../domain/model/HumanAuth.ts";
import type {
  Database,
  HumanIdentityTable,
  HumanUserTable,
  ProjectInvitationTable,
  ProjectMembershipTable,
  WebSessionTable,
} from "../database/schema.ts";

export const toHumanUser = (row: Selectable<HumanUserTable>): HumanUser => ({
  id: row.id,
  displayName: row.display_name,
  email: row.email,
  platformRole: row.platform_role,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const toHumanIdentity = (row: Selectable<HumanIdentityTable>): HumanIdentity => ({
  id: row.id,
  humanUserId: row.human_user_id,
  provider: row.provider,
  issuer: row.issuer,
  subject: row.subject,
  emailAtLogin: row.email_at_login,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
});

/** `token_hash`は返さない。 */
export const toWebSession = (row: Selectable<WebSessionTable>): WebSession => ({
  id: row.id,
  humanUserId: row.human_user_id,
  createdAt: row.created_at,
  lastSeenAt: row.last_seen_at,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  revokeReason: row.revoke_reason,
});

export const toProjectMembership = (row: Selectable<ProjectMembershipTable>): ProjectMembership => ({
  id: row.id,
  projectId: row.project_id,
  humanUserId: row.human_user_id,
  role: row.role,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  createdByHumanUserId: row.created_by_human_user_id,
  revokedAt: row.revoked_at,
  revokedByHumanUserId: row.revoked_by_human_user_id,
});

/** `token_hash`は返さない。 */
export const toProjectInvitation = (row: Selectable<ProjectInvitationTable>): ProjectInvitation => ({
  id: row.id,
  projectId: row.project_id,
  email: row.email,
  role: row.role,
  status: row.status,
  expiresAt: row.expires_at,
  createdByHumanUserId: row.created_by_human_user_id,
  createdAt: row.created_at,
  acceptedByHumanUserId: row.accepted_by_human_user_id,
  acceptedAt: row.accepted_at,
  revokedByHumanUserId: row.revoked_by_human_user_id,
  revokedAt: row.revoked_at,
});

/** Projectの有効なowner数。Role変更・取消の検査と更新は同じ書込transactionで行う。 */
export const countActiveOwners = async (transaction: Transaction<Database>, projectId: string): Promise<number> => {
  const row = await transaction
    .selectFrom("project_membership")
    .select((eb) => eb.fn.countAll<number>().as("count"))
    .where("project_id", "=", projectId)
    .where("role", "=", "owner")
    .where("revoked_at", "is", null)
    .executeTakeFirstOrThrow();
  return Number(row.count);
};
