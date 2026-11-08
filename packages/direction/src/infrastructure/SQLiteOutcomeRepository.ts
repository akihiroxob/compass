import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { Outcome } from "../domain/Outcome.ts";
import type {
  ChangeOutcomeResult,
  CreateOutcomeResult,
  UpdateOutcomeResult,
  OutcomeRepository,
} from "../domain/OutcomeRepository.ts";
import type { CreateOutcomeInput, UpdateOutcomeInput } from "../domain/OutcomeRepository.ts";
import type { DirectionDatabase, OutcomeTable } from "./schema.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import { insertOutcomeRow, loadOutcomes, replaceOutcomeProblems } from "./outcomeRecord.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

export class SQLiteOutcomeRepository implements OutcomeRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly changeObserver: DirectionChangeObserver | null = null,
  ) {}

  async create(
    workspaceId: string,
    intentId: string,
    input: CreateOutcomeInput,
  ): Promise<CreateOutcomeResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateOutcomeResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const intent = await transaction
        .selectFrom("intent")
        .select(["status", "version"])
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      if (input.intentVersion !== intent.version) {
        return { kind: "intent_version_conflict", currentVersion: intent.version };
      }

      const now = Date.now();
      const outcome = await insertOutcomeRow(
        transaction,
        workspaceId,
        intentId,
        crypto.randomUUID(),
        null,
        input,
        now,
        this.changeObserver,
      );
      return { kind: "created", outcome };
    });
  }

  async findByIntent(workspaceId: string, intentId: string): Promise<Outcome[]> {
    const rows = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .where("intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return loadOutcomes(this.database, rows);
  }

  async findByWorkspace(workspaceId: string): Promise<Outcome[]> {
    const rows = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return loadOutcomes(this.database, rows);
  }

  async findById(workspaceId: string, intentId: string, outcomeId: string): Promise<Outcome | null> {
    const row = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("id", "=", outcomeId)
      .where("intent_id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!row) return null;
    const [outcome] = await loadOutcomes(this.database, [row]);
    return outcome ?? null;
  }

  async findByIdInWorkspace(workspaceId: string, outcomeId: string): Promise<Outcome | null> {
    const row = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("id", "=", outcomeId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    if (!row) return null;
    const [outcome] = await loadOutcomes(this.database, [row]);
    return outcome ?? null;
  }

  async findActiveByTargetProject(workspaceId: string, projectId: string): Promise<Outcome[]> {
    const rows = await this.database
      .selectFrom("outcome")
      .innerJoin("outcome_target_project", "outcome_target_project.outcome_id", "outcome.id")
      .selectAll("outcome")
      .where("outcome.workspace_id", "=", workspaceId)
      .where("outcome.status", "=", "active")
      .where("outcome_target_project.project_id", "=", projectId)
      .orderBy("outcome_target_project.created_at", "desc")
      .orderBy(sql`outcome_target_project.rowid`, "desc")
      .execute();
    return loadOutcomes(this.database, rows);
  }

  async update(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    changes: UpdateOutcomeInput,
  ): Promise<UpdateOutcomeResult> {
    // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
    return this.changeActive(
      workspaceId,
      intentId,
      outcomeId,
      { title: changes.title, hypothesis: changes.hypothesis },
      {
        expectedRevision: changes.expectedRevision,
        problems: changes.problems,
        confirmedIntentVersion: changes.intentVersion,
      },
    );
  }

  async cancel(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    reason: string,
  ): Promise<Exclude<ChangeOutcomeResult, { kind: "stale_revision" }>> {
    // 取消は版を指定しないため、stale_revisionにはならない。
    const result = await this.changeActive(workspaceId, intentId, outcomeId, {
      status: "cancelled",
      cancel_reason: reason,
    });
    if (result.kind === "stale_revision") throw new Error("unreachable: cancel does not check the revision");
    // 版の確認を指定しない取消は競合にならない。
    if (result.kind === "intent_version_conflict") throw new Error("unreachable: cancel does not confirm an Intent version");
    return result;
  }

  /** Workspace・Intent配下のactiveなOutcomeだけを、状態確認と同一transactionで更新する。 */
  private async changeActive(
    workspaceId: string,
    intentId: string,
    outcomeId: string,
    changes: Partial<
      Pick<Selectable<OutcomeTable>, "title" | "hypothesis" | "status" | "cancel_reason">
    >,
    options: {
      expectedRevision?: number | undefined;
      problems?: UpdateOutcomeInput["problems"];
      confirmedIntentVersion?: number | undefined;
    } = {},
  ): Promise<UpdateOutcomeResult> {
    const { confirmedIntentVersion } = options;
    return this.database.transaction().execute(async (transaction): Promise<UpdateOutcomeResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const intent = await transaction
        .selectFrom("intent")
        .select(["id", "version"])
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (confirmedIntentVersion !== undefined && confirmedIntentVersion !== intent.version) {
        return { kind: "intent_version_conflict", currentVersion: intent.version };
      }

      const existing = await transaction
        .selectFrom("outcome")
        .select(["status", "revision"])
        .where("id", "=", outcomeId)
        .where("intent_id", "=", intentId)
        .executeTakeFirst();
      if (!existing) return { kind: "outcome_not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      if (options.expectedRevision !== undefined && options.expectedRevision !== existing.revision) {
        return { kind: "stale_revision", currentRevision: existing.revision };
      }

      const now = Date.now();
      if (options.problems !== undefined) {
        await replaceOutcomeProblems(transaction, workspaceId, outcomeId, options.problems, now);
      }
      const row = await transaction
        .updateTable("outcome")
        .set({
          ...changes,
          ...(confirmedIntentVersion === undefined ? {} : { intent_version: confirmedIntentVersion }),
          revision: existing.revision + 1,
          updated_at: now,
        })
        .where("id", "=", outcomeId)
        .returningAll()
        .executeTakeFirstOrThrow();
      if (changes.status === "cancelled") {
        await notifyDirectionChange(this.changeObserver, transaction, {
          type: "outcome_cancelled",
          workspaceId,
          recordId: row.id,
          title: row.title,
          refs: [
            { kind: "outcome", id: row.id },
            { kind: "intent", id: intentId },
          ],
          result: null,
          reason: row.cancel_reason,
          principalId: null,
          occurredAt: row.updated_at,
        });
      }
      const [outcome] = await loadOutcomes(transaction, [row]);
      return { kind: "changed", outcome: outcome! };
    });
  }
}
