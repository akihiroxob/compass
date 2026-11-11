import type { D1Database, D1Result } from "@cloudflare/workers-types";
import { sql, type Kysely, type Selectable } from "kysely";
import { planOutcomeProblems, insertOutcomeConfirmedEventQuery, type DirectionDatabase, type OutcomeRepository, type OutcomeTable,
  type CreateOutcomeInput, type CreateOutcomeResult, type UpdateOutcomeInput, type UpdateOutcomeResult, type ChangeOutcomeResult } from "@compass/direction";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import type { D1DirectionActivityPlanner } from "./planD1DirectionActivity.ts";
import { readD1Outcomes, d1OutcomeSnapshotQueries, outcomesFromD1Results, type D1OutcomeQuery } from "./readD1Outcomes.ts";

export class D1OutcomeRepository implements OutcomeRepository {
  private readonly atomic: D1AtomicBatch;
  constructor(private readonly database: Kysely<DirectionDatabase>, private readonly binding: D1Database,
    private readonly activity: D1DirectionActivityPlanner, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async create(workspaceId: string, intentId: string, input: CreateOutcomeInput): Promise<CreateOutcomeResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const intent = await this.intent(workspaceId, intentId).executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (intent.status !== "active") return { kind: "intent_not_active", status: intent.status };
      if (intent.version !== input.intentVersion) return { kind: "intent_version_conflict", currentVersion: intent.version };
      const now = this.clock();
      const row: Selectable<OutcomeTable> = { id: crypto.randomUUID(), workspace_id: workspaceId, intent_id: intentId,
        intent_version: intent.version, title: input.title, description: input.description, hypothesis: input.hypothesis,
        rationale: input.rationale, status: "active", cancel_reason: null, origin_decision_id: null, revision: 1, created_at: now, updated_at: now };
      const problems = await planOutcomeProblems(this.database, workspaceId, row.id, input.problems, now);
      try {
        const results = await this.atomic.execute([this.writableWorkspace(workspaceId).compile(),
          this.intent(workspaceId, intentId).where("status", "=", "active").where("version", "=", intent.version).compile(),
          ...problems.preconditions], [
          this.database.insertInto("outcome").values(row).compile(),
          ...input.successCriteria.map((criterion, position) => this.database.insertInto("success_criterion").values({ id: crypto.randomUUID(),
            outcome_id: row.id, position, description: criterion.description, measurement: criterion.measurement, target: criterion.target, created_at: now }).compile()),
          ...problems.mutations,
          ...this.activity({ type: "outcome_confirmed", workspaceId, recordId: row.id, title: row.title,
            refs: [{ kind: "outcome", id: row.id }, { kind: "intent", id: intentId }], result: null, reason: null, principalId: null, occurredAt: now }),
          insertOutcomeConfirmedEventQuery(this.database, { workspaceId, intentId, outcomeId: row.id, occurredAt: now }).compile(),
          ...this.snapshotQueries(row.id),
        ]);
        return { kind: "created", outcome: this.snapshotResult(results) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Intent or evidence changed repeatedly during Outcome creation", { intentId });
  }

  findByWorkspace(workspaceId: string) { return this.read(this.ordered(workspaceId)); }
  findByIntent(workspaceId: string, intentId: string) { return this.read(this.ordered(workspaceId).where("intent_id", "=", intentId)); }
  async findById(workspaceId: string, intentId: string, outcomeId: string) {
    return (await this.read(this.current(workspaceId, outcomeId).where("intent_id", "=", intentId)))[0] ?? null;
  }
  async findByIdInWorkspace(workspaceId: string, outcomeId: string) { return (await this.read(this.current(workspaceId, outcomeId)))[0] ?? null; }
  findActiveByTargetProject(workspaceId: string, projectId: string) {
    return this.read(this.database.selectFrom("outcome").selectAll().where("workspace_id", "=", workspaceId).where("status", "=", "active")
      .where((eb) => eb.exists(eb.selectFrom("outcome_target_project").select("outcome_id").whereRef("outcome_id", "=", "outcome.id").where("project_id", "=", projectId)))
      .orderBy(sql`(SELECT created_at FROM outcome_target_project WHERE outcome_id = outcome.id AND project_id = ${projectId})`, "desc")
      .orderBy(sql`(SELECT rowid FROM outcome_target_project WHERE outcome_id = outcome.id AND project_id = ${projectId})`, "desc"));
  }

  update(workspaceId: string, intentId: string, outcomeId: string, input: UpdateOutcomeInput) {
    return this.changeActive(workspaceId, intentId, outcomeId, input);
  }
  async cancel(workspaceId: string, intentId: string, outcomeId: string, reason: string): Promise<Exclude<ChangeOutcomeResult, { kind: "stale_revision" }>> {
    const result = await this.changeActive(workspaceId, intentId, outcomeId, {}, reason);
    if (result.kind === "stale_revision" || result.kind === "intent_version_conflict") throw new Error("cancel cannot check an input revision");
    return result;
  }

  private async changeActive(workspaceId: string, intentId: string, outcomeId: string, input: UpdateOutcomeInput, cancelReason?: string): Promise<UpdateOutcomeResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!await this.writableWorkspace(workspaceId).executeTakeFirst()) return { kind: "workspace_archived" };
      const intent = await this.intent(workspaceId, intentId).executeTakeFirst();
      if (!intent) return { kind: "intent_not_found" };
      if (input.intentVersion !== undefined && input.intentVersion !== intent.version) return { kind: "intent_version_conflict", currentVersion: intent.version };
      const existing = await this.current(workspaceId, outcomeId).where("intent_id", "=", intentId).executeTakeFirst();
      if (!existing) return { kind: "outcome_not_found" };
      if (existing.status !== "active") return { kind: "not_active", status: existing.status };
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) return { kind: "stale_revision", currentRevision: existing.revision };
      const now = this.clock();
      const problems = input.problems === undefined ? { preconditions: [], mutations: [] }
        : await planOutcomeProblems(this.database, workspaceId, outcomeId, input.problems, now);
      const changes = { title: input.title, hypothesis: input.hypothesis, intent_version: input.intentVersion,
        revision: existing.revision + 1, updated_at: now,
        ...(cancelReason === undefined ? {} : { status: "cancelled" as const, cancel_reason: cancelReason }) };
      try {
        const results = await this.atomic.execute([this.writableWorkspace(workspaceId).compile(),
          this.intent(workspaceId, intentId).where("version", "=", intent.version).compile(),
          this.current(workspaceId, outcomeId).where("revision", "=", existing.revision).where("status", "=", "active").compile(),
          ...problems.preconditions], [
          ...problems.mutations,
          this.database.updateTable("outcome").set(changes).where("id", "=", outcomeId).compile(),
          ...(cancelReason === undefined ? [] : this.activity({ type: "outcome_cancelled", workspaceId, recordId: outcomeId, title: existing.title,
            refs: [{ kind: "outcome", id: outcomeId }, { kind: "intent", id: intentId }], result: null, reason: cancelReason, principalId: null, occurredAt: now })),
          ...this.snapshotQueries(outcomeId),
        ]);
        return { kind: "changed", outcome: this.snapshotResult(results) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Outcome or evidence changed repeatedly during update", { outcomeId });
  }

  private snapshotQueries(outcomeId: string) {
    return d1OutcomeSnapshotQueries(this.database, this.database.selectFrom("outcome").selectAll().where("id", "=", outcomeId));
  }
  private snapshotResult(results: D1Result[]) { return outcomesFromD1Results(results.slice(-4))[0]!; }
  private ordered(workspaceId: string) { return this.database.selectFrom("outcome").selectAll().where("workspace_id", "=", workspaceId).orderBy("created_at", "desc").orderBy(sql`rowid`, "desc"); }
  private current(workspaceId: string, id: string) { return this.database.selectFrom("outcome").selectAll().where("workspace_id", "=", workspaceId).where("id", "=", id); }
  private intent(workspaceId: string, id: string) { return this.database.selectFrom("intent").select(["id", "status", "version"]).where("workspace_id", "=", workspaceId).where("id", "=", id); }
  private read(query: D1OutcomeQuery) { return readD1Outcomes(this.database, this.binding, query); }
  private writableWorkspace(workspaceId: string) {
    const organization = asOrganizationDatabase(this.database);
    const archived = organization.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
