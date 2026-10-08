import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import type {
  AddOutcomeTargetProjectResult,
  OutcomeTargetProject,
  OutcomeTargetProjectRepository,
  OutcomeTargetProjectView,
  RemoveOutcomeTargetProjectResult,
} from "../domain/OutcomeTargetProject.ts";
import type { OutcomeStatus } from "../domain/Outcome.ts";
import type { DirectionDatabase, OutcomeTargetProjectTable } from "./schema.ts";
import type { DirectionProjectReaders } from "./directionProjectReaders.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";

type Rejection =
  | { kind: "outcome_not_found" }
  | { kind: "outcome_not_active"; status: OutcomeStatus }
  | { kind: "project_not_found" }
  | { kind: "workspace_archived" };

const toTarget = (row: Selectable<OutcomeTargetProjectTable>): OutcomeTargetProject => ({
  outcomeId: row.outcome_id,
  projectId: row.project_id,
  createdAt: row.created_at,
});

export class SQLiteOutcomeTargetProjectRepository implements OutcomeTargetProjectRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly projects: DirectionProjectReaders,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly clock: () => number = Date.now,
  ) {}

  async add(workspaceId: string, outcomeId: string, projectId: string): Promise<AddOutcomeTargetProjectResult> {
    return this.database.transaction().execute(async (transaction): Promise<AddOutcomeTargetProjectResult> => {
      const rejection = await this.checkChangeable(transaction, workspaceId, outcomeId, projectId);
      if (rejection) return rejection;
      if (await this.projects(transaction).isArchived(projectId)) return { kind: "project_archived" };
      if (await this.findTarget(transaction, outcomeId, projectId)) return { kind: "already_target" };
      const row = await transaction
        .insertInto("outcome_target_project")
        .values({ outcome_id: outcomeId, project_id: projectId, created_at: this.clock() })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "added", target: toTarget(row) };
    });
  }

  async remove(workspaceId: string, outcomeId: string, projectId: string): Promise<RemoveOutcomeTargetProjectResult> {
    return this.database.transaction().execute(async (transaction): Promise<RemoveOutcomeTargetProjectResult> => {
      const rejection = await this.checkChangeable(transaction, workspaceId, outcomeId, projectId);
      if (rejection) return rejection;
      const existing = await this.findTarget(transaction, outcomeId, projectId);
      if (!existing) return { kind: "not_target" };
      await transaction
        .deleteFrom("outcome_target_project")
        .where("outcome_id", "=", outcomeId)
        .where("project_id", "=", projectId)
        .execute();
      return { kind: "removed", target: toTarget(existing) };
    });
  }

  async listByOutcome(workspaceId: string, outcomeId: string): Promise<OutcomeTargetProjectView[] | null> {
    return this.database.transaction().execute(async (transaction) => {
      if (!(await this.findOutcomeStatus(transaction, workspaceId, outcomeId))) return null;
      const rows = await transaction
        .selectFrom("outcome_target_project")
        .selectAll()
        .where("outcome_id", "=", outcomeId)
        .orderBy("created_at")
        .orderBy(sql`rowid`)
        .execute();
      const projects = this.projects(transaction);
      return Promise.all(
        rows.map(async (row): Promise<OutcomeTargetProjectView> => ({
          ...toTarget(row),
          projectStatus: (await projects.isArchived(row.project_id)) ? "archived" : "active",
        })),
      );
    });
  }

  /** Workspaceがactiveで、OutcomeがWorkspace内のactiveなもので、ProjectがOutcomeと同じWorkspaceにあるか。 */
  private async checkChangeable(
    transaction: Transaction<DirectionDatabase>,
    workspaceId: string,
    outcomeId: string,
    projectId: string,
  ): Promise<Rejection | null> {
    if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
    const status = await this.findOutcomeStatus(transaction, workspaceId, outcomeId);
    if (!status) return { kind: "outcome_not_found" };
    if (status !== "active") return { kind: "outcome_not_active", status };
    if ((await this.projects(transaction).findWorkspaceId(projectId)) !== workspaceId) return { kind: "project_not_found" };
    return null;
  }

  private async findOutcomeStatus(
    executor: Transaction<DirectionDatabase>,
    workspaceId: string,
    outcomeId: string,
  ): Promise<OutcomeStatus | null> {
    const row = await executor
      .selectFrom("outcome")
      .select("status")
      .where("id", "=", outcomeId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row?.status ?? null;
  }

  private async findTarget(executor: Transaction<DirectionDatabase>, outcomeId: string, projectId: string) {
    return executor
      .selectFrom("outcome_target_project")
      .selectAll()
      .where("outcome_id", "=", outcomeId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
  }
}
