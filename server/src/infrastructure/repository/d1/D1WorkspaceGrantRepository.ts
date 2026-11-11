import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import {
  SQLiteWorkspaceGrantRepository, activeAgentCredentialElsewhereQuery, 
  type AccessDatabase, type WorkspaceGrantRepository, type WorkspaceRole, type WorkspaceGrantTable,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { accessWorkspaceReaders } from "../accessReaders.ts";

type GrantOutcome = Awaited<ReturnType<WorkspaceGrantRepository["grant"]>>;
type RevokeOutcome = Awaited<ReturnType<WorkspaceGrantRepository["revoke"]>>;

export class D1WorkspaceGrantRepository implements WorkspaceGrantRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: SQLiteWorkspaceGrantRepository;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteWorkspaceGrantRepository(database, accessWorkspaceReaders, clock);
  }

  async grant(scopeId: string, principalId: string, role: WorkspaceRole): Promise<GrantOutcome> {
    const elsewhere = activeAgentCredentialElsewhereQuery(this.database, { kind: "workspace", id: scopeId }, principalId, this.clock());
    const select = this.database.selectFrom("workspace_grant").selectAll()
      .where("workspace_id", "=", scopeId).where("principal_id", "=", principalId).where("role", "=", role);
    try {
      const results = await this.atomic.execute([this.writableScope(scopeId).compile(), sql`SELECT 1 WHERE NOT EXISTS ${elsewhere}`.compile(this.database)], [
        this.database.insertInto("workspace_grant").values({ workspace_id: scopeId, principal_id: principalId, role, created_at: this.clock() })
          .onConflict((conflict) => conflict.columns(["workspace_id", "principal_id", "role"]).doNothing()).returningAll().compile(),
        select.compile(),
      ]);
      const row = results[1]!.results[0] as WorkspaceGrantTable;
      return { kind: "granted", grant: { workspaceId: row.workspace_id, principalId: row.principal_id, role: row.role as WorkspaceRole, createdAt: row.created_at }, created: results[0]!.results.length > 0 };
    } catch (error) {
      if (!(error instanceof D1PreconditionFailedError)) throw error;
      if (!await this.writableScope(scopeId).executeTakeFirst()) return { kind: "workspace_archived" };
      if (await elsewhere.executeTakeFirst()) return { kind: "principal_bound_elsewhere" };
      throw new ConflictError("Grant preconditions changed during D1 operation", { scopeId });
    }
  }

  async revoke(scopeId: string, principalId: string, role: WorkspaceRole): Promise<RevokeOutcome> {
    try {
      const [result] = await this.atomic.execute([this.writableScope(scopeId).compile()], [
        this.database.deleteFrom("workspace_grant").where("workspace_id", "=", scopeId)
          .where("principal_id", "=", principalId).where("role", "=", role).compile(),
      ]);
      return { kind: "revoked", revoked: result!.meta.changes > 0 };
    } catch (error) {
      if (error instanceof D1PreconditionFailedError) return { kind: "workspace_archived" };
      throw error;
    }
  }

  hasRole(scopeId: string, principalId: string, role: WorkspaceRole) { return this.reader.hasRole(scopeId, principalId, role); }
  listWorkspaceIds(principalId: string, role?: WorkspaceRole) { return this.reader.listWorkspaceIds(principalId, role); }
  listByWorkspace(scopeId: string) { return this.reader.listByWorkspace(scopeId); }

  private writableScope(scopeId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", scopeId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
