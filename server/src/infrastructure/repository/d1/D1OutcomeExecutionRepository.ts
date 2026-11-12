import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely } from "kysely";
import { planOutcomeExecutionRecord, type DirectionDatabase, type OutcomeExecutionRepository,
  type RecordOutcomeExecutionInput, type RecordOutcomeExecutionResult } from "@compass/direction";
import { ConflictError, NotFoundError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { readD1OutcomeExecutions } from "./readD1OutcomeExecutions.ts";

export class D1OutcomeExecutionRepository implements OutcomeExecutionRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async record(workspaceId: string, projectId: string, input: RecordOutcomeExecutionInput): Promise<RecordOutcomeExecutionResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const organization = asOrganizationDatabase(this.database);
      const projectQuery = organization.selectFrom("project").select(["id", "status"]).where("id", "=", projectId).where("workspace_id", "=", workspaceId);
      const project = await projectQuery.executeTakeFirst();
      if (!project) throw new NotFoundError(`Project ${projectId} was not found in Workspace ${workspaceId}`);
      const outcome = this.database.selectFrom("outcome").select("id").where("id", "=", input.outcomeId).where("workspace_id", "=", workspaceId);
      if (!await outcome.executeTakeFirst()) throw new NotFoundError(`Outcome ${input.outcomeId} was not found in Workspace ${workspaceId}`);
      const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
      if (await archived.executeTakeFirst()) return { kind: "workspace_archived" };
      if (project.status === "archived") return { kind: "project_archived" };
      const target = this.database.selectFrom("outcome_target_project").select("project_id").where("outcome_id", "=", input.outcomeId).where("project_id", "=", projectId);
      if (!await target.executeTakeFirst()) return { kind: "not_target_project" };
      const snapshot = await readD1OutcomeExecutions(this.database, this.binding, workspaceId, input.outcomeId, projectId);
      const existing = snapshot.summaries[0];
      const plan = planOutcomeExecutionRecord(this.database, workspaceId, projectId, input, existing, snapshot.evidence);
      if (plan.kind === "evidence_limit_exceeded") return plan;
      const summary = this.database.selectFrom("outcome_execution_summary").select("outcome_id").where("workspace_id", "=", workspaceId).where("project_id", "=", projectId).where("outcome_id", "=", input.outcomeId);
      const guards = [sql`SELECT 1 WHERE NOT EXISTS ${archived}`.compile(this.database), projectQuery.where("status", "=", "active").compile(), outcome.compile(), target.compile(),
        existing ? summary.where("execution_cursor", "=", existing.execution_cursor).where("observed_cursor", "=", existing.observed_cursor).compile()
          : sql`SELECT 1 WHERE NOT EXISTS ${summary}`.compile(this.database),
        sql`SELECT 1 WHERE (SELECT COUNT(*) FROM outcome_execution_evidence WHERE workspace_id = ${workspaceId} AND project_id = ${projectId} AND outcome_id = ${input.outcomeId}) = ${snapshot.evidence.length}`.compile(this.database)];
      try {
        await this.atomic.execute(guards, plan.mutations.length ? plan.mutations : [sql`SELECT 1`.compile(this.database)]);
        return plan.result;
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
    }
    throw new ConflictError("Outcome execution changed repeatedly during reflection", { projectId, outcomeId: input.outcomeId });
  }
  async find(workspaceId: string, projectId: string, outcomeId: string) {
    return (await readD1OutcomeExecutions(this.database, this.binding, workspaceId, outcomeId, projectId)).records[0] ?? null;
  }
  async findByOutcome(workspaceId: string, outcomeId: string) { return (await readD1OutcomeExecutions(this.database, this.binding, workspaceId, outcomeId)).records; }
}
