import type { Kysely, Selectable } from "kysely";
import type { ProjectRole } from "../domain/ProjectRole.ts";
import { ProjectGrant } from "../domain/ProjectGrant.ts";
import type { GrantOutcome, ProjectGrantRepository, RevokeOutcome } from "../domain/ProjectGrantRepository.ts";
import type { AccessDatabase, ProjectGrantTable } from "./schema.ts";
import type { AccessExecutor, AccessProjectReaders } from "./AccessProjectReaders.ts";
import { findActiveAgentCredentialElsewhere } from "./SQLiteAccessCredentialRepository.ts";

const toProjectGrant = (row: Selectable<ProjectGrantTable>): ProjectGrant =>
  new ProjectGrant({
    projectId: row.project_id,
    principalId: row.principal_id,
    role: row.role as ProjectRole,
    createdAt: row.created_at,
  });

/**
 * PrincipalがProjectで持つRole（Grantが無ければ空）。Work等が自分のtransactionの中で読むため、
 * 渡された接続・transactionのまま読み、書き込まない。
 */
export const listGrantedRoles = async (
  executor: AccessExecutor,
  projectId: string,
  principalId: string,
): Promise<string[]> => {
  const rows = await executor
    .selectFrom("project_grant")
    .select("role")
    .where("project_id", "=", projectId)
    .where("principal_id", "=", principalId)
    .execute();
  return rows.map((row) => row.role);
};

export class SQLiteProjectGrantRepository implements ProjectGrantRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly projects: AccessProjectReaders,
    /** Agent Credentialの有効期限の判定に使う時刻源。 */
    private readonly clock: () => number = Date.now,
  ) {}

  async grant(projectId: string, principalId: string, role: ProjectRole): Promise<GrantOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<GrantOutcome> => {
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      if (await findActiveAgentCredentialElsewhere(transaction, projectId, principalId, this.clock())) {
        return { kind: "principal_bound_elsewhere" };
      }
      const inserted = await transaction
        .insertInto("project_grant")
        .values({ project_id: projectId, principal_id: principalId, role, created_at: Date.now() })
        .onConflict((conflict) => conflict.columns(["project_id", "principal_id", "role"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { kind: "granted", grant: toProjectGrant(inserted), created: true };

      const existing = await transaction
        .selectFrom("project_grant")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("principal_id", "=", principalId)
        .where("role", "=", role)
        .executeTakeFirstOrThrow();
      return { kind: "granted", grant: toProjectGrant(existing), created: false };
    });
  }

  async revoke(projectId: string, principalId: string, role: ProjectRole): Promise<RevokeOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<RevokeOutcome> => {
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      const result = await transaction
        .deleteFrom("project_grant")
        .where("project_id", "=", projectId)
        .where("principal_id", "=", principalId)
        .where("role", "=", role)
        .executeTakeFirst();
      return { kind: "revoked", revoked: result.numDeletedRows > 0n };
    });
  }

  async hasRole(projectId: string, principalId: string, role: ProjectRole): Promise<boolean> {
    const row = await this.database
      .selectFrom("project_grant")
      .select("principal_id")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .where("role", "=", role)
      .executeTakeFirst();
    return row !== undefined;
  }

  async hasAnyRole(projectId: string, principalId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom("project_grant")
      .select("principal_id")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async listProjectIds(principalId: string, role?: ProjectRole): Promise<string[]> {
    let query = this.database
      .selectFrom("project_grant")
      .select("project_id")
      .distinct()
      .where("principal_id", "=", principalId);
    if (role !== undefined) query = query.where("role", "=", role);
    const rows = await query.execute();
    return rows.map((row) => row.project_id);
  }

  async listByProject(projectId: string): Promise<ProjectGrant[]> {
    const rows = await this.database
      .selectFrom("project_grant")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("role", "asc")
      .orderBy("principal_id", "asc")
      .execute();
    return rows.map(toProjectGrant);
  }
}
