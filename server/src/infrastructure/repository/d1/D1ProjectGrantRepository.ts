import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import {
  SQLiteProjectGrantRepository, activeAgentCredentialElsewhereQuery, ProjectGrant, 
  type AccessDatabase, type ProjectGrantRepository, type ProjectRole, type ProjectGrantTable,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { accessProjectReaders } from "../accessReaders.ts";

type GrantOutcome = Awaited<ReturnType<ProjectGrantRepository["grant"]>>;
type RevokeOutcome = Awaited<ReturnType<ProjectGrantRepository["revoke"]>>;

export class D1ProjectGrantRepository implements ProjectGrantRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: SQLiteProjectGrantRepository;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteProjectGrantRepository(database, accessProjectReaders, clock);
  }

  async grant(scopeId: string, principalId: string, role: ProjectRole): Promise<GrantOutcome> {
    const elsewhere = activeAgentCredentialElsewhereQuery(this.database, { kind: "project", id: scopeId }, principalId, this.clock());
    const select = this.database.selectFrom("project_grant").selectAll()
      .where("project_id", "=", scopeId).where("principal_id", "=", principalId).where("role", "=", role);
    try {
      const results = await this.atomic.execute([this.writableScope(scopeId).compile(), sql`SELECT 1 WHERE NOT EXISTS ${elsewhere}`.compile(this.database)], [
        this.database.insertInto("project_grant").values({ project_id: scopeId, principal_id: principalId, role, created_at: this.clock() })
          .onConflict((conflict) => conflict.columns(["project_id", "principal_id", "role"]).doNothing()).returningAll().compile(),
        select.compile(),
      ]);
      const row = results[1]!.results[0] as ProjectGrantTable;
      return { kind: "granted", grant: new ProjectGrant({ projectId: row.project_id, principalId: row.principal_id, role: row.role as ProjectRole, createdAt: row.created_at }), created: results[0]!.results.length > 0 };
    } catch (error) {
      if (!(error instanceof D1PreconditionFailedError)) throw error;
      if (!await this.writableScope(scopeId).executeTakeFirst()) return { kind: "project_archived" };
      if (await elsewhere.executeTakeFirst()) return { kind: "principal_bound_elsewhere" };
      throw new ConflictError("Grant preconditions changed during D1 operation", { scopeId });
    }
  }

  async revoke(scopeId: string, principalId: string, role: ProjectRole): Promise<RevokeOutcome> {
    try {
      const [result] = await this.atomic.execute([this.writableScope(scopeId).compile()], [
        this.database.deleteFrom("project_grant").where("project_id", "=", scopeId)
          .where("principal_id", "=", principalId).where("role", "=", role).compile(),
      ]);
      return { kind: "revoked", revoked: result!.meta.changes > 0 };
    } catch (error) {
      if (error instanceof D1PreconditionFailedError) return { kind: "project_archived" };
      throw error;
    }
  }

  hasRole(scopeId: string, principalId: string, role: ProjectRole) { return this.reader.hasRole(scopeId, principalId, role); }
  hasAnyRole(projectId: string, principalId: string) { return this.reader.hasAnyRole(projectId, principalId); }
  listProjectIds(principalId: string, role?: ProjectRole) { return this.reader.listProjectIds(principalId, role); }
  listByProject(scopeId: string) { return this.reader.listByProject(scopeId); }

  private writableScope(scopeId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("project").select("id").where("id", "=", scopeId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
