import { sql, type Kysely } from "kysely";
import type { HumanRole, WorkspaceMembership } from "../domain/HumanAuth.ts";
import type {
  AddWorkspaceMemberCommand,
  AddWorkspaceMemberResult,
  ChangeWorkspaceMemberRoleResult,
  RevokeWorkspaceMemberResult,
  WorkspaceMemberView,
  WorkspaceMembershipRepository,
} from "../domain/WorkspaceMembershipRepository.ts";
import type { AccessDatabase } from "./schema.ts";
import type { AccessWorkspaceReaders } from "./AccessWorkspaceReaders.ts";
import { countActiveWorkspaceOwners, toWorkspaceMembership } from "./humanAuthRecord.ts";

export class SQLiteWorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly workspaces: AccessWorkspaceReaders,
    private readonly clock: () => number = Date.now,
  ) {}

  async findActiveMembership(workspaceId: string, humanUserId: string): Promise<WorkspaceMembership | null> {
    const row = await this.database
      .selectFrom("workspace_membership")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("human_user_id", "=", humanUserId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row ? toWorkspaceMembership(row) : null;
  }

  async listActiveWorkspaceIds(humanUserId: string): Promise<string[]> {
    const rows = await this.database
      .selectFrom("workspace_membership")
      .select("workspace_id")
      .where("human_user_id", "=", humanUserId)
      .where("revoked_at", "is", null)
      .execute();
    return rows.map(({ workspace_id }) => workspace_id);
  }

  async listActiveMembers(workspaceId: string): Promise<WorkspaceMemberView[]> {
    const rows = await this.database
      .selectFrom("workspace_membership")
      .innerJoin("human_user", "human_user.id", "workspace_membership.human_user_id")
      .selectAll("workspace_membership")
      .select(["human_user.display_name", "human_user.email"])
      .where("workspace_membership.workspace_id", "=", workspaceId)
      .where("workspace_membership.revoked_at", "is", null)
      .orderBy(
        sql`case workspace_membership.role when 'owner' then 0 when 'administrator' then 1 when 'editor' then 2 else 3 end`,
      )
      .orderBy("workspace_membership.created_at")
      .execute();
    return rows.map(({ display_name, email, ...row }) => ({
      membership: toWorkspaceMembership(row),
      human: { id: row.human_user_id, displayName: display_name, email },
    }));
  }

  async add(command: AddWorkspaceMemberCommand): Promise<AddWorkspaceMemberResult> {
    return this.database.transaction().execute(async (transaction): Promise<AddWorkspaceMemberResult> => {
      const workspaces = this.workspaces(transaction);
      if (await workspaces.isArchived(command.workspaceId)) return { kind: "workspace_archived" };
      const projectIds = await workspaces.listProjectIds(command.workspaceId);
      if (projectIds.length === 0) return { kind: "not_project_member" };
      const projectMember = await transaction
        .selectFrom("project_membership")
        .select("id")
        .where("project_id", "in", projectIds)
        .where("human_user_id", "=", command.humanUserId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!projectMember) return { kind: "not_project_member" };
      const existing = await transaction
        .selectFrom("workspace_membership")
        .select("id")
        .where("workspace_id", "=", command.workspaceId)
        .where("human_user_id", "=", command.humanUserId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (existing) return { kind: "already_member" };
      const now = this.clock();
      const row = await transaction
        .insertInto("workspace_membership")
        .values({
          id: crypto.randomUUID(),
          workspace_id: command.workspaceId,
          human_user_id: command.humanUserId,
          role: command.role,
          created_at: now,
          updated_at: now,
          created_by_human_user_id: command.createdByHumanUserId,
          revoked_at: null,
          revoked_by_human_user_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "added", membership: toWorkspaceMembership(row) };
    });
  }

  async changeRole(workspaceId: string, membershipId: string, role: HumanRole): Promise<ChangeWorkspaceMemberRoleResult> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeWorkspaceMemberRoleResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const existing = await transaction
        .selectFrom("workspace_membership")
        .selectAll()
        .where("id", "=", membershipId)
        .where("workspace_id", "=", workspaceId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.role === role) return { kind: "changed", membership: toWorkspaceMembership(existing) };
      if (existing.role === "owner" && (await countActiveWorkspaceOwners(transaction, workspaceId)) <= 1) {
        return { kind: "last_owner" };
      }
      const updated = await transaction
        .updateTable("workspace_membership")
        .set({ role, updated_at: this.clock() })
        .where("id", "=", membershipId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "changed", membership: toWorkspaceMembership(updated) };
    });
  }

  async revoke(workspaceId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeWorkspaceMemberResult> {
    return this.database.transaction().execute(async (transaction): Promise<RevokeWorkspaceMemberResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const existing = await transaction
        .selectFrom("workspace_membership")
        .selectAll()
        .where("id", "=", membershipId)
        .where("workspace_id", "=", workspaceId)
        .where("revoked_at", "is", null)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.role === "owner" && (await countActiveWorkspaceOwners(transaction, workspaceId)) <= 1) {
        return { kind: "last_owner" };
      }
      // 行は削除しない（監査）。
      const now = this.clock();
      const updated = await transaction
        .updateTable("workspace_membership")
        .set({ revoked_at: now, revoked_by_human_user_id: revokedByHumanUserId, updated_at: now })
        .where("id", "=", membershipId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "revoked", membership: toWorkspaceMembership(updated) };
    });
  }
}
