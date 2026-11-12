import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import {
  SQLiteWorkspaceMembershipRepository, toWorkspaceMembership,
  type AccessDatabase, type HumanRole, type WorkspaceMembershipRepository,
  type ChangeWorkspaceMemberRoleResult, type RevokeWorkspaceMemberResult,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { accessWorkspaceReaders } from "../accessReaders.ts";

type MembershipChange = { role: HumanRole } | { revokedByHumanUserId: string };

export class D1WorkspaceMembershipRepository implements WorkspaceMembershipRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<WorkspaceMembershipRepository, "findActiveMembership" | "listActiveWorkspaceIds" | "listActiveMembers">;

  constructor(
    private readonly database: Kysely<AccessDatabase>,
    binding: D1Database,
    private readonly clock: () => number = Date.now,
  ) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteWorkspaceMembershipRepository(database, accessWorkspaceReaders);
  }

  findActiveMembership(workspaceId: string, humanUserId: string) {
    return this.reader.findActiveMembership(workspaceId, humanUserId);
  }

  listActiveWorkspaceIds(humanUserId: string) {
    return this.reader.listActiveWorkspaceIds(humanUserId);
  }

  listActiveMembers(workspaceId: string) {
    return this.reader.listActiveMembers(workspaceId);
  }

  async changeRole(workspaceId: string, membershipId: string, role: HumanRole): Promise<ChangeWorkspaceMemberRoleResult> {
    const result = await this.change(workspaceId, membershipId, { role });
    return result.kind === "saved" ? { kind: "changed", membership: result.membership } : result;
  }

  async revoke(workspaceId: string, membershipId: string, revokedByHumanUserId: string): Promise<RevokeWorkspaceMemberResult> {
    const result = await this.change(workspaceId, membershipId, { revokedByHumanUserId });
    return result.kind === "saved" ? { kind: "revoked", membership: result.membership } : result;
  }

  private async change(workspaceId: string, membershipId: string, change: MembershipChange) {
    const workspace = asOrganizationDatabase(this.database).selectFrom("workspace").select("status").where("id", "=", workspaceId);
    const membership = this.database.selectFrom("workspace_membership")
      .where("id", "=", membershipId).where("workspace_id", "=", workspaceId).where("revoked_at", "is", null);
    const otherOwner = this.database.selectFrom("workspace_membership").select("id")
      .where("workspace_id", "=", workspaceId).where("role", "=", "owner")
      .where("revoked_at", "is", null).where("id", "!=", membershipId);

    for (let attempt = 0; attempt < 3; attempt++) {
      const scope = await workspace.executeTakeFirst();
      if (scope?.status === "archived") return { kind: "workspace_archived" } as const;
      const existing = await membership.selectAll().executeTakeFirst();
      if (!existing) return { kind: "not_found" } as const;
      if ("role" in change && change.role === existing.role) {
        return { kind: "saved", membership: toWorkspaceMembership(existing) } as const;
      }

      const guards = [workspace.where("status", "!=", "archived").compile(),
        membership.select("id").where("role", "=", existing.role).compile()];
      if (existing.role === "owner") {
        if (!await otherOwner.executeTakeFirst()) return { kind: "last_owner" } as const;
        guards.push(otherOwner.compile());
      }
      const now = this.clock();
      const values = "role" in change
        ? { role: change.role, updated_at: now }
        : { revoked_at: now, revoked_by_human_user_id: change.revokedByHumanUserId, updated_at: now };
      try {
        await this.atomic.execute(guards, [
          this.database.updateTable("workspace_membership").set(values).where("id", "=", membershipId).compile(),
        ]);
        return { kind: "saved", membership: toWorkspaceMembership({ ...existing, ...values }) } as const;
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Workspace membership changed repeatedly during update", { workspaceId, membershipId });
  }
}
