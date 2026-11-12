import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import type { DirectionDatabase, OutcomeTargetProjectRepository, OutcomeTargetProjectView,
  AddOutcomeTargetProjectResult, RemoveOutcomeTargetProjectResult } from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { asApplicationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

/** Organizationの現在状態とTargetを、同じD1 batch／SELECTで照合する。 */
export class D1OutcomeTargetProjectRepository implements OutcomeTargetProjectRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly database;

  constructor(database: Kysely<DirectionDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.database = asApplicationDatabase(database);
    this.atomic = new D1AtomicBatch(binding);
  }

  async add(workspaceId: string, outcomeId: string, projectId: string): Promise<AddOutcomeTargetProjectResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejection = await this.checkChangeable(workspaceId, outcomeId, projectId);
      if (rejection) return rejection;
      const project = await this.project(workspaceId, projectId).executeTakeFirstOrThrow();
      if (project.status === "archived") return { kind: "project_archived" };
      if (await this.target(outcomeId, projectId).executeTakeFirst()) return { kind: "already_target" };
      const createdAt = this.clock();
      try {
        await this.atomic.execute([
          ...this.changeGuards(workspaceId, outcomeId, projectId),
          this.project(workspaceId, projectId).where("status", "=", "active").compile(),
          sql`SELECT 1 WHERE NOT EXISTS ${this.target(outcomeId, projectId)}`.compile(this.database),
        ], [this.database.insertInto("outcome_target_project").values({ outcome_id: outcomeId, project_id: projectId, created_at: createdAt }).compile()]);
        return { kind: "added", target: { outcomeId, projectId, createdAt } };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Outcome target changed repeatedly during addition", { outcomeId, projectId });
  }

  async remove(workspaceId: string, outcomeId: string, projectId: string): Promise<RemoveOutcomeTargetProjectResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const rejection = await this.checkChangeable(workspaceId, outcomeId, projectId);
      if (rejection) return rejection;
      const existing = await this.target(outcomeId, projectId).executeTakeFirst();
      if (!existing) return { kind: "not_target" };
      try {
        await this.atomic.execute([
          ...this.changeGuards(workspaceId, outcomeId, projectId),
          this.target(outcomeId, projectId).where("created_at", "=", existing.created_at).compile(),
        ], [this.database.deleteFrom("outcome_target_project").where("outcome_id", "=", outcomeId).where("project_id", "=", projectId).compile()]);
        return { kind: "removed", target: { outcomeId, projectId, createdAt: existing.created_at } };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Outcome target changed repeatedly during removal", { outcomeId, projectId });
  }

  async listByOutcome(workspaceId: string, outcomeId: string): Promise<OutcomeTargetProjectView[] | null> {
    // LEFT JOINでTargetなしとOutcome不在を一度のSELECTで区別する。
    const rows = await this.database.selectFrom("outcome")
      .leftJoin("outcome_target_project as target", "target.outcome_id", "outcome.id")
      .leftJoin("project", "project.id", "target.project_id")
      .select(["target.outcome_id", "target.project_id", "target.created_at", "project.status as project_status"])
      .where("outcome.workspace_id", "=", workspaceId).where("outcome.id", "=", outcomeId)
      .orderBy("target.created_at").orderBy(sql`target.rowid`).execute();
    if (rows.length === 0) return null;
    return rows.flatMap((row) => row.project_id === null ? [] : [{ outcomeId: row.outcome_id!, projectId: row.project_id,
      createdAt: row.created_at!, projectStatus: row.project_status ?? "active" }]);
  }

  async listByWorkspace(workspaceId: string): Promise<OutcomeTargetProjectView[]> {
    return this.list(this.views(workspaceId));
  }

  async listByIntent(workspaceId: string, intentId: string): Promise<OutcomeTargetProjectView[]> {
    return this.list(this.views(workspaceId).where("outcome.intent_id", "=", intentId));
  }

  private views(workspaceId: string) {
    return this.database.selectFrom("outcome_target_project as target")
      .innerJoin("outcome", "outcome.id", "target.outcome_id")
      .innerJoin("project", "project.id", "target.project_id")
      .select(["target.outcome_id", "target.project_id", "target.created_at", "project.status as project_status"])
      .where("outcome.workspace_id", "=", workspaceId).orderBy("target.created_at").orderBy(sql`target.rowid`);
  }

  private async list(query: ReturnType<D1OutcomeTargetProjectRepository["views"]>): Promise<OutcomeTargetProjectView[]> {
    return (await query.execute()).map((row) => ({ outcomeId: row.outcome_id, projectId: row.project_id,
      createdAt: row.created_at, projectStatus: row.project_status }));
  }

  private writableWorkspace(workspaceId: string) {
    const archived = this.database.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return this.database.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }

  private outcome(workspaceId: string, outcomeId: string) {
    return this.database.selectFrom("outcome").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", outcomeId);
  }

  private project(workspaceId: string, projectId: string) {
    return this.database.selectFrom("project").select(["id", "status"]).where("workspace_id", "=", workspaceId).where("id", "=", projectId);
  }

  private target(outcomeId: string, projectId: string) {
    return this.database.selectFrom("outcome_target_project").selectAll().where("outcome_id", "=", outcomeId).where("project_id", "=", projectId);
  }

  private changeGuards(workspaceId: string, outcomeId: string, projectId: string) {
    return [this.writableWorkspace(workspaceId).compile(), this.outcome(workspaceId, outcomeId).where("status", "=", "active").compile(),
      this.project(workspaceId, projectId).compile()];
  }

  private async checkChangeable(workspaceId: string, outcomeId: string, projectId: string) {
    if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" as const };
    const outcome = await this.outcome(workspaceId, outcomeId).executeTakeFirst();
    if (!outcome) return { kind: "outcome_not_found" as const };
    if (outcome.status !== "active") return { kind: "outcome_not_active" as const, status: outcome.status };
    if (!await this.project(workspaceId, projectId).executeTakeFirst()) return { kind: "project_not_found" as const };
    return null;
  }
}
