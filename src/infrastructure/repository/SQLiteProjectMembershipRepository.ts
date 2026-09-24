import { sql, type Kysely } from "kysely";
import type { HumanRole, ProjectInvitation, ProjectMembership } from "../../domain/model/HumanAuth.ts";
import type {
  ChangeMemberRoleResult,
  CreateInvitationCommand,
  CreateInvitationResult,
  MemberView,
  ProjectMembershipRepository,
  RevokeInvitationResult,
  RevokeMemberResult,
} from "../../domain/repository/ProjectMembershipRepository.ts";
import type { Database } from "../database/schema.ts";
import { countActiveOwners, toProjectInvitation, toProjectMembership } from "./humanAuthRecord.ts";

const isUniqueViolation = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";

export class SQLiteProjectMembershipRepository implements ProjectMembershipRepository {
  constructor(
    private readonly database: Kysely<Database>,
    private readonly clock: () => number = Date.now,
  ) {}

  async findActiveMembership(projectId: string, humanUserId: string): Promise<ProjectMembership | null> {
    const row = await this.database
      .selectFrom("project_membership")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("human_user_id", "=", humanUserId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row ? toProjectMembership(row) : null;
  }

  async listActiveProjectIds(humanUserId: string): Promise<string[]> {
    const rows = await this.database
      .selectFrom("project_membership")
      .select("project_id")
      .where("human_user_id", "=", humanUserId)
      .where("revoked_at", "is", null)
      .execute();
    return rows.map(({ project_id }) => project_id);
  }

  async listActiveMembers(projectId: string): Promise<MemberView[]> {
    const rows = await this.database
      .selectFrom("project_membership")
      .innerJoin("human_user", "human_user.id", "project_membership.human_user_id")
      .selectAll("project_membership")
      .select(["human_user.display_name", "human_user.email"])
      .where("project_membership.project_id", "=", projectId)
      .where("project_membership.revoked_at", "is", null)
      .orderBy(
        sql`case project_membership.role when 'owner' then 0 when 'administrator' then 1 when 'editor' then 2 else 3 end`,
      )
      .orderBy("project_membership.created_at")
      .execute();
    return rows.map(({ display_name, email, ...row }) => ({
      membership: toProjectMembership(row),
      human: { id: row.human_user_id, displayName: display_name, email },
    }));
  }

  async changeRole(projectId: string, membershipId: string, role: HumanRole): Promise<ChangeMemberRoleResult> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeMemberRoleResult> => {
      const existing = await transaction
        .selectFrom("project_membership")
        .selectAll()
        .where("id", "=", membershipId)
        .where("project_id", "=", projectId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.role === role) return { kind: "changed", membership: toProjectMembership(existing) };
      if (existing.role === "owner" && (await countActiveOwners(transaction, projectId)) <= 1) {
        return { kind: "last_owner" };
      }
      const updated = await transaction
        .updateTable("project_membership")
        .set({ role, updated_at: this.clock() })
        .where("id", "=", membershipId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "changed", membership: toProjectMembership(updated) };
    });
  }

  async revoke(projectId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeMemberResult> {
    return this.database.transaction().execute(async (transaction): Promise<RevokeMemberResult> => {
      const existing = await transaction
        .selectFrom("project_membership")
        .selectAll()
        .where("id", "=", membershipId)
        .where("project_id", "=", projectId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.role === "owner" && (await countActiveOwners(transaction, projectId)) <= 1) {
        return { kind: "last_owner" };
      }
      // 行は削除しない（監査）。
      const now = this.clock();
      const updated = await transaction
        .updateTable("project_membership")
        .set({ revoked_at: now, revoked_by_human_user_id: revokedByHumanUserId, updated_at: now })
        .where("id", "=", membershipId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "revoked", membership: toProjectMembership(updated) };
    });
  }

  async createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult> {
    try {
      return await this.database.transaction().execute(async (transaction): Promise<CreateInvitationResult> => {
        const now = this.clock();
        // 期限切れのpendingは受諾・取消できないが、同じ宛先の再発行を塞がないよう、再発行と同時に取消扱いにする。
        await transaction
          .updateTable("project_invitation")
          .set({ status: "revoked", revoked_by_human_user_id: command.createdByHumanUserId, revoked_at: now })
          .where("project_id", "=", command.projectId)
          .where("email", "=", command.email)
          .where("status", "=", "pending")
          .where("expires_at", "<=", now)
          .execute();
        const row = await transaction
          .insertInto("project_invitation")
          .values({
            id: crypto.randomUUID(),
            project_id: command.projectId,
            email: command.email,
            role: command.role,
            token_hash: command.tokenHash,
            status: "pending",
            expires_at: command.expiresAt,
            created_by_human_user_id: command.createdByHumanUserId,
            created_at: now,
            accepted_by_human_user_id: null,
            accepted_at: null,
            revoked_by_human_user_id: null,
            revoked_at: null,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        return { kind: "created", invitation: toProjectInvitation(row) };
      });
    } catch (error) {
      // 部分unique index（project_id, email where pending）で、期限内の未使用招待がある宛先への発行を1件に限る。
      if (isUniqueViolation(error)) return { kind: "pending_exists" };
      throw error;
    }
  }

  async listInvitations(projectId: string): Promise<ProjectInvitation[]> {
    const rows = await this.database
      .selectFrom("project_invitation")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toProjectInvitation);
  }

  async revokeInvitation(
    projectId: string,
    invitationId: string,
    revokedByHumanUserId: string,
  ): Promise<RevokeInvitationResult> {
    return this.database.transaction().execute(async (transaction): Promise<RevokeInvitationResult> => {
      const now = this.clock();
      const existing = await transaction
        .selectFrom("project_invitation")
        .select(["status", "expires_at"])
        .where("id", "=", invitationId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "pending" || existing.expires_at <= now) return { kind: "not_pending" };
      const updated = await transaction
        .updateTable("project_invitation")
        .set({ status: "revoked", revoked_by_human_user_id: revokedByHumanUserId, revoked_at: now })
        .where("id", "=", invitationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "revoked", invitation: toProjectInvitation(updated) };
    });
  }
}
