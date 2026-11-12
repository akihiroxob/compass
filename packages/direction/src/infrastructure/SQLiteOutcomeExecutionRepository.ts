import type { Kysely } from "kysely";
import { sql } from "kysely";
import { type OutcomeExecutionRecord } from "../domain/OutcomeExecution.ts";
import type {
  OutcomeExecutionRepository,
  RecordOutcomeExecutionInput,
  RecordOutcomeExecutionResult,
} from "../domain/OutcomeExecutionRepository.ts";
import type { DirectionDatabase } from "./schema.ts";
import { readOutcomeExecutionRecords, toEvidence, toSummary } from "./outcomeTargetExecutionRecord.ts";
import { planOutcomeExecutionRecord } from "./outcomeExecutionRecordPlan.ts";
import { NotFoundError } from "@compass/shared";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import type { DirectionProjectReaders } from "./directionProjectReaders.ts";

export class SQLiteOutcomeExecutionRepository implements OutcomeExecutionRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly projects: DirectionProjectReaders,
    private readonly workspaces: DirectionWorkspaceReaders,
  ) {}

  async record(workspaceId: string, projectId: string, input: RecordOutcomeExecutionInput): Promise<RecordOutcomeExecutionResult> {
    return this.database.transaction().execute(async (transaction): Promise<RecordOutcomeExecutionResult> => {
      if (await this.projects(transaction).findWorkspaceId(projectId) !== workspaceId) throw new NotFoundError(`Project ${projectId} was not found in Workspace ${workspaceId}`);
      const outcome = await transaction.selectFrom("outcome").select("id").where("id", "=", input.outcomeId).where("workspace_id", "=", workspaceId).executeTakeFirst();
      if (!outcome) throw new NotFoundError(`Outcome ${input.outcomeId} was not found in Workspace ${workspaceId}`);
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      // Target別の還流。Targetの解除・追加と同じtransactionで検査し、Target外のProjectの結果をOutcomeへ混ぜない。
      const target = await transaction.selectFrom("outcome_target_project").select("project_id")
        .where("outcome_id", "=", input.outcomeId).where("project_id", "=", projectId).executeTakeFirst();
      if (!target) return { kind: "not_target_project" };

      const existing = await transaction
        .selectFrom("outcome_execution_summary")
        .selectAll()
        .where("workspace_id", "=", workspaceId)
        .where("project_id", "=", projectId)
        .where("outcome_id", "=", input.outcomeId)
        .executeTakeFirst();
      const stored = await transaction.selectFrom("outcome_execution_evidence").selectAll().where("workspace_id", "=", workspaceId)
        .where("project_id", "=", projectId).where("outcome_id", "=", input.outcomeId).orderBy("observed_at").orderBy("created_at").orderBy(sql`rowid`).execute();
      const plan = planOutcomeExecutionRecord(transaction, workspaceId, projectId, input, existing, stored);
      if (plan.kind === "evidence_limit_exceeded") return plan;
      for (const query of plan.mutations) await transaction.executeQuery(query);
      return plan.result;
    });
  }

  async find(workspaceId: string, projectId: string, outcomeId: string): Promise<OutcomeExecutionRecord | null> {
    return this.load(this.database, workspaceId, projectId, outcomeId);
  }

  async findByOutcome(workspaceId: string, outcomeId: string): Promise<OutcomeExecutionRecord[]> {
    return readOutcomeExecutionRecords(this.database, workspaceId, outcomeId);
  }

  private async load(
    database: Kysely<DirectionDatabase>,
    workspaceId: string,
    projectId: string,
    outcomeId: string,
  ): Promise<OutcomeExecutionRecord | null> {
    const summary = await database
      .selectFrom("outcome_execution_summary")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("project_id", "=", projectId)
      .where("outcome_id", "=", outcomeId)
      .executeTakeFirst();
    if (!summary) return null;
    const evidence = await database
      .selectFrom("outcome_execution_evidence")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("project_id", "=", projectId)
      .where("outcome_id", "=", outcomeId)
      .orderBy("observed_at", "asc")
      .orderBy("created_at", "asc")
      .orderBy(sql`rowid`, "asc")
      .execute();
    return { summary: toSummary(summary), evidence: evidence.map(toEvidence) };
  }
}
