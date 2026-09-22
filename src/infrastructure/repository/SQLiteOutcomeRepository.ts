import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import type { Outcome } from "../../domain/model/Outcome.ts";
import type {
  ChangeOutcomeResult,
  CreateOutcomeResult,
  OutcomeRepository,
} from "../../domain/repository/OutcomeRepository.ts";
import type { CreateOutcomeInput, UpdateOutcomeInput } from "../../shared/outcomeSchema.ts";
import type { Database, OutcomeTable } from "../database/schema.ts";
import { isProjectArchived } from "./isProjectArchived.ts";
import { insertOutcomeRow, loadOutcomes } from "./outcomeRecord.ts";

export class SQLiteOutcomeRepository implements OutcomeRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async create(
    projectId: string,
    intentId: string,
    input: CreateOutcomeInput,
  ): Promise<CreateOutcomeResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateOutcomeResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };
      const intent = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };

      const now = Date.now();
      const outcome = await insertOutcomeRow(transaction, projectId, intentId, crypto.randomUUID(), null, input, now);
      return { kind: "created", outcome };
    });
  }

  async findByIntent(projectId: string, intentId: string): Promise<Outcome[]> {
    const rows = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("intent_id", "=", intentId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return loadOutcomes(this.database, rows);
  }

  async findById(projectId: string, intentId: string, outcomeId: string): Promise<Outcome | null> {
    const row = await this.database
      .selectFrom("outcome")
      .selectAll()
      .where("id", "=", outcomeId)
      .where("intent_id", "=", intentId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    if (!row) return null;
    const [outcome] = await loadOutcomes(this.database, [row]);
    return outcome ?? null;
  }

  async update(
    projectId: string,
    intentId: string,
    outcomeId: string,
    changes: UpdateOutcomeInput,
  ): Promise<ChangeOutcomeResult> {
    // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
    return this.changeActive(projectId, intentId, outcomeId, {
      title: changes.title,
      hypothesis: changes.hypothesis,
    });
  }

  async cancel(
    projectId: string,
    intentId: string,
    outcomeId: string,
    reason: string,
  ): Promise<ChangeOutcomeResult> {
    return this.changeActive(projectId, intentId, outcomeId, {
      status: "cancelled",
      cancel_reason: reason,
    });
  }

  /** Project・Intent配下のactiveなOutcomeだけを、状態確認と同一transactionで更新する。 */
  private async changeActive(
    projectId: string,
    intentId: string,
    outcomeId: string,
    changes: Partial<
      Pick<Selectable<OutcomeTable>, "title" | "hypothesis" | "status" | "cancel_reason">
    >,
  ): Promise<ChangeOutcomeResult> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeOutcomeResult> => {
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };
      const intent = await transaction
        .selectFrom("intent")
        .select("id")
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };

      const existing = await transaction
        .selectFrom("outcome")
        .select("status")
        .where("id", "=", outcomeId)
        .where("intent_id", "=", intentId)
        .executeTakeFirst();
      if (!existing) return { kind: "outcome_not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };

      const row = await transaction
        .updateTable("outcome")
        .set({ ...changes, updated_at: Date.now() })
        .where("id", "=", outcomeId)
        .returningAll()
        .executeTakeFirstOrThrow();
      const [outcome] = await loadOutcomes(transaction, [row]);
      return { kind: "changed", outcome: outcome! };
    });
  }
}
