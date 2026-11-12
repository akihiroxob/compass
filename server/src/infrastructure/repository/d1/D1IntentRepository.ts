import type { D1Database } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable } from "kysely";
import {
  SQLiteIntentRepository, intentFromRow, insertIntentRevisionQuery, planIntentEdit,
  type DirectionDatabase, type IntentRepository, type IntentActor, type CreateIntentInput, type UpdateIntentInput,
  type CreateIntentResult, type UpdateIntentResult, type ChangeIntentResult, type IntentTable,
} from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { directionWorkspaceReaders } from "../directionReaders.ts";
import type { D1DirectionActivityPlanner } from "./planD1DirectionActivity.ts";

export class D1IntentRepository implements IntentRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<IntentRepository, "findById" | "findByWorkspace" | "findRevisions">;

  constructor(private readonly database: Kysely<DirectionDatabase>, binding: D1Database,
    private readonly activity: D1DirectionActivityPlanner, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteIntentRepository(database, directionWorkspaceReaders);
  }

  async create(workspaceId: string, input: CreateIntentInput, actor: IntentActor): Promise<CreateIntentResult> {
    const now = this.clock();
    const row: Selectable<IntentTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, title: input.title,
      desired_state: input.desiredState, background: input.background, audience: input.audience, constraints: input.constraints,
      completion_definition: input.completionDefinition, target_date: input.targetDate, status: "active", abandoned_reason: null,
      version: 1, meaning_version: 1, created_at: now, updated_at: now };
    try {
      await this.atomic.execute([this.writableWorkspace(workspaceId).compile()], [
        this.database.insertInto("intent").values(row).compile(), insertIntentRevisionQuery(this.database, row, false, null, actor).compile(),
        ...this.activity({ type: "intent_created", workspaceId, recordId: row.id, title: row.title, refs: [{ kind: "intent", id: row.id }],
          result: null, reason: null, principalId: null, occurredAt: now }),
      ]);
      return { kind: "created", intent: intentFromRow(row) };
    } catch (error) {
      if (error instanceof D1PreconditionFailedError) return { kind: "workspace_archived" };
      throw error;
    }
  }

  findById(workspaceId: string, id: string) { return this.reader.findById(workspaceId, id); }
  findByWorkspace(workspaceId: string) { return this.reader.findByWorkspace(workspaceId); }
  findRevisions(workspaceId: string, id: string) { return this.reader.findRevisions(workspaceId, id); }

  async update(workspaceId: string, intentId: string, input: UpdateIntentInput, actor: IntentActor): Promise<UpdateIntentResult> {
    for (let retry = 0; retry < 3; retry++) {
      if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const existing = await this.current(workspaceId, intentId).executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      if (existing.version !== input.expectedVersion) return { kind: "version_conflict", currentVersion: existing.version };
      const { changedMeaning, reason, next, unchanged } = planIntentEdit(existing, input);
      const guards = [this.writableWorkspace(workspaceId).compile(), this.current(workspaceId, intentId).where("version", "=", existing.version).where("status", "=", "active").compile()];
      if (changedMeaning.length && reason === null) {
        const outcomes = this.database.selectFrom("outcome").select("id").where("intent_id", "=", intentId);
        if (await outcomes.executeTakeFirst()) return { kind: "reason_required", fields: changedMeaning };
        guards.push(sql`SELECT 1 WHERE NOT EXISTS ${outcomes}`.compile(this.database));
      }
      if (unchanged) return { kind: "changed", intent: intentFromRow(existing) };
      const row = { ...existing, ...next, version: existing.version + 1,
        meaning_version: changedMeaning.length ? existing.version + 1 : existing.meaning_version, updated_at: this.clock() };
      try {
        await this.atomic.execute(guards, [this.database.updateTable("intent").set(row).where("id", "=", intentId).compile(),
          insertIntentRevisionQuery(this.database, row, changedMeaning.length > 0, reason, actor).compile()]);
        return { kind: "changed", intent: intentFromRow(row) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Intent changed repeatedly during update", { intentId });
  }

  async abandon(workspaceId: string, intentId: string, reason: string | null, expectedVersion?: number): Promise<ChangeIntentResult> {
    for (let retry = 0; retry < 3; retry++) {
      if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const existing = await this.current(workspaceId, intentId).executeTakeFirst();
      if (!existing) return { kind: "not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      if (expectedVersion !== undefined && expectedVersion !== existing.version) return { kind: "version_conflict", currentVersion: existing.version };
      const now = this.clock();
      const row = { ...existing, status: "abandoned" as const, abandoned_reason: reason, updated_at: now };
      const cancellationReason = reason ? `Intent abandoned: ${reason}` : "Intent abandoned";
      try {
        await this.atomic.execute([this.writableWorkspace(workspaceId).compile(),
          this.current(workspaceId, intentId).where("version", "=", existing.version).where("status", "=", "active").compile()], [
          this.database.updateTable("intent").set({ status: "abandoned", abandoned_reason: reason, updated_at: now }).where("id", "=", intentId).compile(),
          this.database.updateTable("outcome").set({ status: "cancelled", cancel_reason: cancellationReason, updated_at: now })
            .where("intent_id", "=", intentId).where("status", "=", "active").compile(),
          this.database.updateTable("research_request").set({ status: "cancelled", stop_reason: cancellationReason, updated_at: now })
            .where("origin_intent_id", "=", intentId).where("status", "in", ["requested", "running"]).compile(),
          ...this.activity({ type: "intent_abandoned", workspaceId, recordId: intentId, title: existing.title, refs: [{ kind: "intent", id: intentId }],
            result: null, reason, principalId: null, occurredAt: now }),
        ]);
        return { kind: "changed", intent: intentFromRow(row) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Intent changed repeatedly during abandonment", { intentId });
  }

  private current(workspaceId: string, intentId: string) {
    return this.database.selectFrom("intent").selectAll().where("id", "=", intentId).where("workspace_id", "=", workspaceId);
  }

  private writableWorkspace(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
