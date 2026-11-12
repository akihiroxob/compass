import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import {
  SQLiteWorkspaceInvitationRepository, toWorkspaceInvitation,
  type AccessDatabase, type WorkspaceInvitationRepository, type WorkspaceInvitationTable,
  type CreateInvitationCommand, type CreateInvitationResult, type RevokeInvitationResult,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { accessWorkspaceReaders } from "../accessReaders.ts";

export class D1WorkspaceInvitationRepository implements WorkspaceInvitationRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<WorkspaceInvitationRepository, "listInvitations">;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteWorkspaceInvitationRepository(database, accessWorkspaceReaders, clock);
  }

  async createInvitation(command: CreateInvitationCommand): Promise<CreateInvitationResult> {
    const now = this.clock();
    try {
      const results = await this.atomic.execute([this.writableScope(command.workspaceId).compile()], [
        this.database.updateTable("workspace_invitation").set({ status: "revoked", revoked_by_human_user_id: command.createdByHumanUserId, revoked_at: now })
          .where("workspace_id", "=", command.workspaceId).where("email", "=", command.email).where("status", "=", "pending").where("expires_at", "<=", now).compile(),
        this.database.insertInto("workspace_invitation").values({ id: crypto.randomUUID(), workspace_id: command.workspaceId,
          email: command.email, role: command.role, token_hash: command.tokenHash, status: "pending", expires_at: command.expiresAt,
          created_by_human_user_id: command.createdByHumanUserId, created_at: now, accepted_by_human_user_id: null, accepted_at: null,
          revoked_by_human_user_id: null, revoked_at: null })
          .onConflict((conflict) => conflict.columns(["workspace_id", "email"]).where(sql<boolean>`status = 'pending'`).doNothing()).returningAll().compile(),
      ]);
      const row = results[1]!.results[0] as WorkspaceInvitationTable | undefined;
      return row ? { kind: "created", invitation: toWorkspaceInvitation(row) } : { kind: "pending_exists" };
    } catch (error) {
      if (error instanceof D1PreconditionFailedError) return { kind: "workspace_archived" };
      throw error;
    }
  }

  listInvitations(workspaceId: string) { return this.reader.listInvitations(workspaceId); }

  async revokeInvitation(workspaceId: string, invitationId: string, revokedByHumanUserId: string): Promise<RevokeInvitationResult> {
    const query = this.database.selectFrom("workspace_invitation").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", invitationId);
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writableScope(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const now = this.clock();
      const existing = await query.executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "pending" || existing.expires_at <= now) return { kind: "not_pending" };
      try {
        const results = await this.atomic.execute([this.writableScope(workspaceId).compile(),
          query.where("status", "=", "pending").where("expires_at", "=", existing.expires_at).where("token_hash", "=", existing.token_hash).compile()], [
          this.database.updateTable("workspace_invitation").set({ status: "revoked", revoked_by_human_user_id: revokedByHumanUserId, revoked_at: now })
            .where("id", "=", invitationId).returningAll().compile(),
        ]);
        return { kind: "revoked", invitation: toWorkspaceInvitation(results[0]!.results[0] as WorkspaceInvitationTable) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Invitation changed repeatedly during revoke", { workspaceId, invitationId });
  }

  private writableScope(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
