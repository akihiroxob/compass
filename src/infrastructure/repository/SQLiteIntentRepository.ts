import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import { Intent } from "../../domain/model/Intent.ts";
import type {
  ChangeIntentResult,
  CreateIntentResult,
  IntentRepository,
  MeaningLockedResult,
  UpdateIntentResult,
} from "../../domain/repository/IntentRepository.ts";
import type { CreateIntentInput, UpdateIntentInput } from "../../shared/intentSchema.ts";
import type { Database, IntentTable } from "../database/schema.ts";

const toIntent = (row: Selectable<IntentTable>): Intent =>
  new Intent({
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    desiredState: row.desired_state,
    completionDefinition: row.completion_definition,
    status: row.status,
    abandonedReason: row.abandoned_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

export class SQLiteIntentRepository implements IntentRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async create(projectId: string, input: CreateIntentInput): Promise<CreateIntentResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateIntentResult> => {
      const active = await transaction
        .selectFrom("intent")
        .select("id")
        .where("project_id", "=", projectId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (active) return { kind: "active_exists", activeIntentId: active.id };

      const now = Date.now();
      const row = await transaction
        .insertInto("intent")
        .values({
          id: crypto.randomUUID(),
          project_id: projectId,
          title: input.title,
          desired_state: input.desiredState,
          completion_definition: input.completionDefinition,
          status: "active",
          abandoned_reason: null,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "created", intent: toIntent(row) };
    });
  }

  async findByProject(projectId: string): Promise<Intent[]> {
    const rows = await this.database
      .selectFrom("intent")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return rows.map(toIntent);
  }

  async findById(projectId: string, intentId: string): Promise<Intent | null> {
    const row = await this.database
      .selectFrom("intent")
      .selectAll()
      .where("id", "=", intentId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row ? toIntent(row) : null;
  }

  async update(
    projectId: string,
    intentId: string,
    input: UpdateIntentInput,
  ): Promise<UpdateIntentResult> {
    // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
    return this.changeActive(
      projectId,
      intentId,
      {
        title: input.title,
        desired_state: input.desiredState,
        completion_definition: input.completionDefinition,
      },
      {
        // Outcomeは、そのIntentの意味に対する仮説。意味が変わると根拠を失うため、Outcomeを持つIntentでは変更させない。
        guard: async (transaction, existing): Promise<MeaningLockedResult | null> => {
          const fields = [
            ...(input.desiredState !== undefined && input.desiredState !== existing.desired_state
              ? ["desiredState"]
              : []),
            ...(input.completionDefinition !== undefined &&
            input.completionDefinition !== existing.completion_definition
              ? ["completionDefinition"]
              : []),
          ];
          if (fields.length === 0) return null;
          const outcome = await transaction
            .selectFrom("outcome")
            .select("id")
            .where("intent_id", "=", intentId)
            .executeTakeFirst();
          return outcome ? { kind: "meaning_locked", fields } : null;
        },
      },
    );
  }

  async abandon(
    projectId: string,
    intentId: string,
    reason: string | null,
  ): Promise<ChangeIntentResult> {
    return this.changeActive<never>(
      projectId,
      intentId,
      { status: "abandoned", abandoned_reason: reason },
      {
        // 放棄されたIntentにactiveなOutcomeを残さない。
        afterChange: async (transaction) => {
          await transaction
            .updateTable("outcome")
            .set({
              status: "cancelled",
              cancel_reason: reason ? `Intent abandoned: ${reason}` : "Intent abandoned",
              updated_at: Date.now(),
            })
            .where("intent_id", "=", intentId)
            .where("status", "=", "active")
            .execute();
        },
      },
    );
  }

  /**
   * Project配下のactiveなIntentだけを、状態確認と同一transactionで更新する。
   * guardは更新前に結果を返して拒否でき、afterChangeは同一transaction内で関連データを更新する。
   */
  private async changeActive<Rejection extends MeaningLockedResult = never>(
    projectId: string,
    intentId: string,
    changes: Partial<Omit<IntentTable, "id" | "project_id" | "created_at" | "updated_at">>,
    hooks: {
      guard?: (
        transaction: Transaction<Database>,
        existing: Selectable<IntentTable>,
      ) => Promise<Rejection | null>;
      afterChange?: (transaction: Transaction<Database>) => Promise<void>;
    } = {},
  ): Promise<ChangeIntentResult | Rejection> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeIntentResult | Rejection> => {
      const existing = await transaction
        .selectFrom("intent")
        .selectAll()
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      const rejected = await hooks.guard?.(transaction, existing);
      if (rejected) return rejected;

      const row = await transaction
        .updateTable("intent")
        .set({ ...changes, updated_at: Date.now() })
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await hooks.afterChange?.(transaction);
      return { kind: "changed", intent: toIntent(row) };
    });
  }
}
