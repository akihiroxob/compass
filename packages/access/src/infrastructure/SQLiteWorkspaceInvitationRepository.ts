import type { Kysely } from "kysely";
import type { WorkspaceInvitation } from "../domain/HumanAuth.ts";
import type {
  CreateInvitationCommand,
  CreateInvitationResult,
  WorkspaceInvitationRepository,
  RevokeInvitationResult,
} from "../domain/WorkspaceInvitationRepository.ts";
import type { AccessDatabase } from "./schema.ts";
import type { AccessWorkspaceReaders } from "./AccessWorkspaceReaders.ts";
import { toWorkspaceInvitation } from "./humanAuthRecord.ts";

const isUniqueViolation = (error: unknown) =>
  error instanceof Error && "code" in error && error.code === "SQLITE_CONSTRAINT_UNIQUE";

export class SQLiteWorkspaceInvitationRepository implements WorkspaceInvitationRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly workspaces: AccessWorkspaceReaders,
    private readonly clock: () => number = Date.now,
  ) {}

  async createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult> {
    try {
      return await this.database.transaction().execute(async (transaction): Promise<CreateInvitationResult> => {
        if (await this.workspaces(transaction).isArchived(command.workspaceId)) return { kind: "workspace_archived" };
        const now = this.clock();
        // 期限切れのpendingは受諾・取消できないが、同じ宛先の再発行を塞がないよう、再発行と同時に取消扱いにする。
        await transaction
          .updateTable("workspace_invitation")
          .set({ status: "revoked", revoked_by_human_user_id: command.createdByHumanUserId, revoked_at: now })
          .where("workspace_id", "=", command.workspaceId)
          .where("email", "=", command.email)
          .where("status", "=", "pending")
          .where("expires_at", "<=", now)
          .execute();
        const row = await transaction
          .insertInto("workspace_invitation")
          .values({
            id: crypto.randomUUID(),
            workspace_id: command.workspaceId,
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
        return { kind: "created", invitation: toWorkspaceInvitation(row) };
      });
    } catch (error) {
      // 部分unique index（workspace_id, email where pending）で、期限内の未使用招待がある宛先への発行を1件に限る。
      if (isUniqueViolation(error)) return { kind: "pending_exists" };
      throw error;
    }
  }

  async listInvitations(workspaceId: string): Promise<WorkspaceInvitation[]> {
    const rows = await this.database
      .selectFrom("workspace_invitation")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy("id")
      .execute();
    return rows.map(toWorkspaceInvitation);
  }

  async revokeInvitation(
    workspaceId: string,
    invitationId: string,
    revokedByHumanUserId: string,
  ): Promise<RevokeInvitationResult> {
    return this.database.transaction().execute(async (transaction): Promise<RevokeInvitationResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const now = this.clock();
      const existing = await transaction
        .selectFrom("workspace_invitation")
        .select(["status", "expires_at"])
        .where("id", "=", invitationId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "pending" || existing.expires_at <= now) return { kind: "not_pending" };
      const updated = await transaction
        .updateTable("workspace_invitation")
        .set({ status: "revoked", revoked_by_human_user_id: revokedByHumanUserId, revoked_at: now })
        .where("id", "=", invitationId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "revoked", invitation: toWorkspaceInvitation(updated) };
    });
  }
}
