import type { Kysely, Selectable } from "kysely";
import type { ProjectRole } from "../../constants/ProjectRole.ts";
import { ProjectGrant } from "../../domain/model/ProjectGrant.ts";
import type { GrantResult, ProjectGrantRepository } from "../../domain/repository/ProjectGrantRepository.ts";
import type { Database, ProjectGrantTable } from "../database/schema.ts";

const toProjectGrant = (row: Selectable<ProjectGrantTable>): ProjectGrant =>
  new ProjectGrant({
    projectId: row.project_id,
    principalId: row.principal_id,
    role: row.role as ProjectRole,
    createdAt: row.created_at,
  });

export class SQLiteProjectGrantRepository implements ProjectGrantRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async grant(projectId: string, principalId: string, role: ProjectRole): Promise<GrantResult> {
    return this.database.transaction().execute(async (transaction) => {
      const inserted = await transaction
        .insertInto("project_grant")
        .values({ project_id: projectId, principal_id: principalId, role, created_at: Date.now() })
        .onConflict((conflict) => conflict.columns(["project_id", "principal_id", "role"]).doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { grant: toProjectGrant(inserted), created: true };

      const existing = await transaction
        .selectFrom("project_grant")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("principal_id", "=", principalId)
        .where("role", "=", role)
        .executeTakeFirstOrThrow();
      return { grant: toProjectGrant(existing), created: false };
    });
  }

  async revoke(projectId: string, principalId: string, role: ProjectRole): Promise<boolean> {
    const result = await this.database
      .deleteFrom("project_grant")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .where("role", "=", role)
      .executeTakeFirst();
    return result.numDeletedRows > 0n;
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
