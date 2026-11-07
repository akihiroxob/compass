import type { Kysely, Selectable, Transaction } from "kysely";
import { sql } from "kysely";
import { Intent, type IntentRevision } from "../domain/Intent.ts";
import type {
  ChangeIntentResult,
  CreateIntentResult,
  IntentActor,
  IntentRepository,
  ReasonRequiredResult,
  UpdateIntentResult,
} from "../domain/IntentRepository.ts";
import type { CreateIntentInput, UpdateIntentInput } from "../domain/IntentRepository.ts";
import type { DirectionDatabase, IntentRevisionTable, IntentTable } from "./schema.ts";
import type { DirectionWorkspaceReaders } from "./directionWorkspaceReaders.ts";
import { notifyDirectionChange, type DirectionChangeObserver } from "./directionChange.ts";

const toIntent = (row: Selectable<IntentTable>): Intent =>
  new Intent({
    id: row.id,
    workspaceId: row.workspace_id,
    title: row.title,
    desiredState: row.desired_state,
    background: row.background,
    audience: row.audience,
    constraints: row.constraints,
    completionDefinition: row.completion_definition,
    targetDate: row.target_date,
    status: row.status,
    abandonedReason: row.abandoned_reason,
    version: row.version,
    meaningVersion: row.meaning_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const toRevision = (row: Selectable<IntentRevisionTable>): IntentRevision => ({
  intentId: row.intent_id,
  workspaceId: row.workspace_id,
  version: row.version,
  title: row.title,
  desiredState: row.desired_state,
  background: row.background,
  audience: row.audience,
  constraints: row.constraints,
  completionDefinition: row.completion_definition,
  targetDate: row.target_date,
  meaningChanged: row.meaning_changed === 1,
  reason: row.reason,
  changedBy: row.changed_by,
  changedByRole: row.changed_by_role,
  createdAt: row.created_at,
});

/** 保存した版の内容を履歴へ残す。同じ版は1件だけ（主キー）。 */
const insertRevision = async (
  transaction: Transaction<DirectionDatabase>,
  intent: Selectable<IntentTable>,
  meaningChanged: boolean,
  reason: string | null,
  actor: IntentActor,
): Promise<void> => {
  await transaction
    .insertInto("intent_revision")
    .values({
      intent_id: intent.id,
      workspace_id: intent.workspace_id,
      version: intent.version,
      title: intent.title,
      desired_state: intent.desired_state,
      background: intent.background,
      audience: intent.audience,
      constraints: intent.constraints,
      completion_definition: intent.completion_definition,
      target_date: intent.target_date,
      meaning_changed: meaningChanged ? 1 : 0,
      reason,
      changed_by: actor.principalId,
      changed_by_role: actor.role,
      created_at: intent.updated_at,
    })
    .execute();
};

export class SQLiteIntentRepository implements IntentRepository {
  constructor(
    private readonly database: Kysely<DirectionDatabase>,
    private readonly workspaces: DirectionWorkspaceReaders,
    private readonly changeObserver: DirectionChangeObserver | null = null,
  ) {}

  async create(workspaceId: string, input: CreateIntentInput, actor: IntentActor): Promise<CreateIntentResult> {
    return this.database.transaction().execute(async (transaction): Promise<CreateIntentResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const now = Date.now();
      const row = await transaction
        .insertInto("intent")
        .values({
          id: crypto.randomUUID(),
          workspace_id: workspaceId,
          title: input.title,
          desired_state: input.desiredState,
          background: input.background,
          audience: input.audience,
          constraints: input.constraints,
          completion_definition: input.completionDefinition,
          target_date: input.targetDate,
          status: "active",
          abandoned_reason: null,
          version: 1,
          meaning_version: 1,
          created_at: now,
          updated_at: now,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await insertRevision(transaction, row, false, null, actor);
      await notifyDirectionChange(this.changeObserver, transaction, {
        type: "intent_created",
        workspaceId,
        recordId: row.id,
        title: row.title,
        refs: [{ kind: "intent", id: row.id }],
        result: null,
        reason: null,
        principalId: null,
        occurredAt: now,
      });
      return { kind: "created", intent: toIntent(row) };
    });
  }

  async findByWorkspace(workspaceId: string): Promise<Intent[]> {
    const rows = await this.database
      .selectFrom("intent")
      .selectAll()
      .where("workspace_id", "=", workspaceId)
      .orderBy("created_at", "desc")
      .orderBy(sql`rowid`, "desc")
      .execute();
    return rows.map(toIntent);
  }

  async findById(workspaceId: string, intentId: string): Promise<Intent | null> {
    const row = await this.database
      .selectFrom("intent")
      .selectAll()
      .where("id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .executeTakeFirst();
    return row ? toIntent(row) : null;
  }

  async update(
    workspaceId: string,
    intentId: string,
    input: UpdateIntentInput,
    actor: IntentActor,
  ): Promise<UpdateIntentResult> {
    return this.database.transaction().execute(async (transaction): Promise<UpdateIntentResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const existing = await transaction
        .selectFrom("intent")
        .selectAll()
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      // 古い編集画面・古い版の判断は、内容を上書きせず競合として返す。
      if (existing.version !== input.expectedVersion) {
        return { kind: "version_conflict", currentVersion: existing.version };
      }

      const changedMeaning = [
        ...(input.desiredState !== undefined && input.desiredState !== existing.desired_state ? ["desiredState"] : []),
        ...(input.completionDefinition !== undefined && input.completionDefinition !== existing.completion_definition
          ? ["completionDefinition"]
          : []),
      ];
      const reason = input.reason ?? null;
      if (changedMeaning.length > 0 && reason === null) {
        // Outcomeは、そのIntentの意味に対する仮説。意味を変えるなら、既存の根拠をどう扱うかを理由として残させる。
        const outcome = await transaction
          .selectFrom("outcome")
          .select("id")
          .where("intent_id", "=", intentId)
          .executeTakeFirst();
        if (outcome) return { kind: "reason_required", fields: changedMeaning } satisfies ReasonRequiredResult;
      }

      const next = {
        title: input.title ?? existing.title,
        desired_state: input.desiredState ?? existing.desired_state,
        background: input.background === undefined ? existing.background : input.background,
        audience: input.audience === undefined ? existing.audience : input.audience,
        constraints: input.constraints === undefined ? existing.constraints : input.constraints,
        completion_definition:
          input.completionDefinition === undefined ? existing.completion_definition : input.completionDefinition,
        target_date: input.targetDate === undefined ? existing.target_date : input.targetDate,
      };
      const unchanged = (Object.keys(next) as (keyof typeof next)[]).every((key) => next[key] === existing[key]);
      // 内容が変わらない保存は版を進めず、履歴も増やさない。
      if (unchanged) return { kind: "changed", intent: toIntent(existing) };

      const version = existing.version + 1;
      const row = await transaction
        .updateTable("intent")
        .set({
          ...next,
          version,
          meaning_version: changedMeaning.length > 0 ? version : existing.meaning_version,
          updated_at: Date.now(),
        })
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .where("version", "=", existing.version)
        .returningAll()
        .executeTakeFirstOrThrow();
      await insertRevision(transaction, row, changedMeaning.length > 0, reason, actor);
      return { kind: "changed", intent: toIntent(row) };
    });
  }

  async findRevisions(workspaceId: string, intentId: string): Promise<IntentRevision[] | null> {
    if (!(await this.findById(workspaceId, intentId))) return null;
    const rows = await this.database
      .selectFrom("intent_revision")
      .selectAll()
      .where("intent_id", "=", intentId)
      .where("workspace_id", "=", workspaceId)
      .orderBy("version", "desc")
      .execute();
    return rows.map(toRevision);
  }

  async abandon(
    workspaceId: string,
    intentId: string,
    reason: string | null,
    expectedVersion?: number,
  ): Promise<ChangeIntentResult> {
    return this.changeActive(
      workspaceId,
      intentId,
      { status: "abandoned", abandoned_reason: reason },
      {
        expectedVersion,
        // 放棄されたIntentにactiveなOutcomeを残さない。
        afterChange: async (transaction, intent) => {
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
          // 放棄されたIntentの未終了Research Requestも取り消す。取消は次の判断の起動条件ではないためイベントは作らない。
          await transaction
            .updateTable("research_request")
            .set({
              status: "cancelled",
              stop_reason: reason ? `Intent abandoned: ${reason}` : "Intent abandoned",
              updated_at: Date.now(),
            })
            .where("origin_intent_id", "=", intentId)
            .where("status", "in", ["requested", "running"])
            .execute();
          // 連動したOutcome・Requestの取消は放棄の帰結なので、Activityは放棄の1件だけにする。
          await notifyDirectionChange(this.changeObserver, transaction, {
            type: "intent_abandoned",
            workspaceId,
            recordId: intent.id,
            title: intent.title,
            refs: [{ kind: "intent", id: intent.id }],
            result: null,
            reason,
            principalId: null,
            occurredAt: intent.updated_at,
          });
        },
      },
    );
  }

  /**
   * Workspace配下のactiveなIntentだけを、状態確認と同一transactionで更新する。
   * afterChangeは同一transaction内で関連データを更新する。`expectedVersion`を指定した場合は現在版との一致を条件にする。
   */
  private async changeActive(
    workspaceId: string,
    intentId: string,
    changes: Partial<Pick<IntentTable, "status" | "abandoned_reason">>,
    hooks: {
      expectedVersion?: number;
      afterChange?: (transaction: Transaction<DirectionDatabase>, intent: Selectable<IntentTable>) => Promise<void>;
    } = {},
  ): Promise<ChangeIntentResult> {
    return this.database.transaction().execute(async (transaction): Promise<ChangeIntentResult> => {
      if (await this.workspaces(transaction).isArchived(workspaceId)) return { kind: "workspace_archived" };
      const existing = await transaction
        .selectFrom("intent")
        .selectAll()
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      if (hooks.expectedVersion !== undefined && hooks.expectedVersion !== existing.version) {
        return { kind: "version_conflict", currentVersion: existing.version };
      }

      const row = await transaction
        .updateTable("intent")
        .set({ ...changes, updated_at: Date.now() })
        .where("id", "=", intentId)
        .where("workspace_id", "=", workspaceId)
        .returningAll()
        .executeTakeFirstOrThrow();
      await hooks.afterChange?.(transaction, row);
      return { kind: "changed", intent: toIntent(row) };
    });
  }
}
