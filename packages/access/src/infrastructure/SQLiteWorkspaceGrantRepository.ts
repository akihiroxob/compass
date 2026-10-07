import type { Kysely, Selectable } from "kysely";
import type { WorkspaceRole } from "../domain/RoleScope.ts";
import type { WorkspaceGrant, WorkspaceGrantRepository } from "../domain/WorkspaceGrant.ts";
import type { AccessDatabase, WorkspaceGrantTable } from "./schema.ts";
import type { AccessWorkspaceReaders } from "./AccessWorkspaceReaders.ts";

type WorkspaceGrantOutcome = Awaited<ReturnType<WorkspaceGrantRepository["grant"]>>;
type WorkspaceRevokeOutcome = Awaited<ReturnType<WorkspaceGrantRepository["revoke"]>>;
const toWorkspaceGrant = (row: Selectable<WorkspaceGrantTable>): WorkspaceGrant => ({
  workspaceId: row.workspace_id, principalId: row.principal_id,
  role: row.role as WorkspaceRole, createdAt: row.created_at,
});

export class SQLiteWorkspaceGrantRepository implements WorkspaceGrantRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly workspaces: AccessWorkspaceReaders,
    private readonly clock: () => number = Date.now,
  ) {}

  async grant(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<WorkspaceGrantOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<WorkspaceGrantOutcome> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const inserted = await transaction
        .insertInto("workspace_grant")
        .values({ workspace_id: workspaceId, principal_id: principalId, role, created_at: this.clock() })
        .onConflict((conflict) => conflict.columns(["workspace_id", "principal_id", "role"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { kind: "granted", grant: toWorkspaceGrant(inserted), created: true };

      const existing = await transaction
        .selectFrom("workspace_grant")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("principal_id", "=", principalId)
        .where("role", "=", role)
        .executeTakeFirstOrThrow();
      return { kind: "granted", grant: toWorkspaceGrant(existing), created: false };
    });
  }

  async revoke(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<WorkspaceRevokeOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<WorkspaceRevokeOutcome> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const result = await transaction
        .deleteFrom("workspace_grant")
        .where("workspace_id", "=", workspaceId)
        .where("principal_id", "=", principalId)
        .where("role", "=", role)
        .executeTakeFirst();
      return { kind: "revoked", revoked: result.numDeletedRows > 0n };
    });
  }

  async hasRole(workspaceId: string, principalId: string, role: WorkspaceRole): Promise<boolean> {
    const row = await this.database
      .selectFrom("workspace_grant")
      .select("principal_id")
      .where("workspace_id", "=", workspaceId)
      .where("principal_id", "=", principalId)
      .where("role", "=", role)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listWorkspaceIds(principalId: string, role?: WorkspaceRole): Promise<string[]> {
    let query = this.database
      .selectFrom("workspace_grant")
      .select("workspace_id")
      .distinct()
      .where("principal_id", "=", principalId);
    if (role !== undefined) query = query.where("role", "=", role);
    const rows = await query.execute();
    return rows.map((row) => row.workspace_id);
  }

  async listByWorkspace(workspaceId: string): Promise<WorkspaceGrant[]> {
    const rows = await this.database
      .selectFrom("workspace_grant")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("role", "asc")
      .orderBy("principal_id", "asc")
      .execute();
    return rows.map(toWorkspaceGrant);
  }
}
