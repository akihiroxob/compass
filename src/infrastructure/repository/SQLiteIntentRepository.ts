import type { Kysely, Selectable } from "kysely";
import { sql } from "kysely";
import { Intent } from "../../domain/model/Intent.ts";
import type {
  ChangeIntentResult,
  CreateIntentResult,
  IntentRepository,
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
  ): Promise<ChangeIntentResult> {
    // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
    return this.changeActive(projectId, intentId, {
      title: input.title,
      desired_state: input.desiredState,
      completion_definition: input.completionDefinition,
    });
  }

  async abandon(
    projectId: string,
    intentId: string,
    reason: string | null,
  ): Promise<ChangeIntentResult> {
    return this.changeActive(projectId, intentId, {
      status: "abandoned",
      abandoned_reason: reason,
    });
  }

  /** Project配下のactiveなIntentだけを、状態確認と同一transactionで更新する。 */
  private async changeActive(
    projectId: string,
    intentId: string,
    changes: Partial<Omit<IntentTable, "id" | "project_id" | "created_at" | "updated_at">>,
  ): Promise<ChangeIntentResult> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeIntentResult> => {
      const existing = await transaction
        .selectFrom("intent")
        .select("status")
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };

      const row = await transaction
        .updateTable("intent")
        .set({ ...changes, updated_at: Date.now() })
        .where("id", "=", intentId)
        .where("project_id", "=", projectId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "changed", intent: toIntent(row) };
    });
  }
}
