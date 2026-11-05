import { sql, type ExpressionBuilder, type Kysely, type Selectable, type Transaction } from "kysely";
import type { AgentRun, AgentRunIdentity, AgentRunRecordResult, AgentRunRepository, AgentRunStart, AgentRunStatus, AgentRunWorkKind } from "../domain/AgentRun.ts";
import type { ProjectRole } from "../domain/ProjectRole.ts";
import type { RoleScope } from "../domain/RoleScope.ts";
import type { AccessDatabase, AgentRunTable } from "./schema.ts";

const toAgentRun = (row: Selectable<AgentRunTable>): AgentRun => ({
  runId: row.run_id,
  scope: { kind: row.scope_kind, id: row.scope_id },
  principalId: row.principal_id,
  role: row.role as ProjectRole,
  source: row.source as AgentRun["source"],
  provider: row.provider,
  workRef: row.work_kind === null || row.work_id === null ? null : { kind: row.work_kind as AgentRunWorkKind, id: row.work_id },
  reporter: { kind: row.reporter_kind, principalId: row.reporter_principal_id },
  status: row.status,
  startedAt: row.started_at,
  observedAt: row.observed_at,
  staleAt: row.stale_at,
  endedAt: row.ended_at,
  reason: row.reason,
});

const sameIdentity = (run: AgentRun, identity: AgentRunIdentity) =>
  run.scope.kind === identity.scope.kind && run.scope.id === identity.scope.id && run.principalId === identity.principalId && run.role === identity.role;

/** scope（Workspace / Project）のいずれかに一致する条件。空なら何も一致しない。 */
const inScopes = (scopes: readonly RoleScope[]) => (eb: ExpressionBuilder<AccessDatabase, "agent_run">) =>
  eb.or(scopes.map((scope) => eb.and([eb("scope_kind", "=", scope.kind), eb("scope_id", "=", scope.id)])));

export class SQLiteAgentRunRepository implements AgentRunRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly clock: () => number = Date.now,
  ) {}

  private async find(transaction: Transaction<AccessDatabase>, runId: string): Promise<AgentRun | null> {
    const row = await transaction.selectFrom("agent_run").selectAll().where("run_id", "=", runId).executeTakeFirst();
    return row ? toAgentRun(row) : null;
  }

  async start(input: AgentRunStart): Promise<AgentRunRecordResult> {
    return this.database.transaction().execute(async (transaction): Promise<AgentRunRecordResult> => {
      const now = this.clock();
      const inserted = await transaction
        .insertInto("agent_run")
        .values({
          run_id: input.runId,
          scope_kind: input.scope.kind,
          scope_id: input.scope.id,
          principal_id: input.principalId,
          role: input.role,
          source: input.source,
          provider: input.provider,
          work_kind: input.workRef?.kind ?? null,
          work_id: input.workRef?.id ?? null,
          reporter_kind: input.reporter.kind,
          reporter_principal_id: input.reporter.principalId,
          status: "running",
          started_at: now,
          observed_at: now,
          stale_at: now + input.staleAfterMs,
          ended_at: null,
          reason: null,
        })
        .onConflict((conflict) => conflict.column("run_id").doNothing())
        .returningAll()
        .executeTakeFirst();
      if (inserted) return { kind: "recorded", run: toAgentRun(inserted), changed: true };
      const existing = (await this.find(transaction, input.runId))!;
      return sameIdentity(existing, input) ? { kind: "recorded", run: existing, changed: false } : { kind: "identity_mismatch", run: existing };
    });
  }

  async observe(identity: AgentRunIdentity, staleAfterMs: number): Promise<AgentRunRecordResult> {
    return this.database.transaction().execute(async (transaction): Promise<AgentRunRecordResult> => {
      const existing = await this.find(transaction, identity.runId);
      if (!existing) return { kind: "not_found" };
      if (!sameIdentity(existing, identity)) return { kind: "identity_mismatch", run: existing };
      if (existing.status !== "running") return { kind: "recorded", run: existing, changed: false };
      const now = this.clock();
      const updated = await transaction
        .updateTable("agent_run")
        .set({ observed_at: now, stale_at: now + staleAfterMs })
        .where("run_id", "=", identity.runId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "recorded", run: toAgentRun(updated), changed: true };
    });
  }

  async finish(identity: AgentRunIdentity, status: Exclude<AgentRunStatus, "running">, reason: string | null): Promise<AgentRunRecordResult> {
    return this.database.transaction().execute(async (transaction): Promise<AgentRunRecordResult> => {
      const existing = await this.find(transaction, identity.runId);
      if (!existing) return { kind: "not_found" };
      if (!sameIdentity(existing, identity)) return { kind: "identity_mismatch", run: existing };
      if (existing.status !== "running") {
        return existing.status === status ? { kind: "recorded", run: existing, changed: false } : { kind: "already_finished", run: existing };
      }
      const now = this.clock();
      const updated = await transaction
        .updateTable("agent_run")
        .set({ status, reason, observed_at: now, stale_at: now, ended_at: now })
        .where("run_id", "=", identity.runId)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "recorded", run: toAgentRun(updated), changed: true };
    });
  }

  async listLatest(scopes: readonly RoleScope[]): Promise<AgentRun[]> {
    if (scopes.length === 0) return [];
    // Principal・scope・Roleの組ごとに、最新の開始の1件だけを返す。
    const rows = await this.database
      .selectFrom((eb) =>
        eb
          .selectFrom("agent_run")
          .selectAll()
          .select(sql<number>`row_number() over (partition by principal_id, scope_kind, scope_id, role order by started_at desc, run_id desc)`.as("rank"))
          .where(inScopes(scopes))
          .as("ranked"),
      )
      .selectAll()
      .where("rank", "=", 1)
      .orderBy("started_at", "desc")
      .execute();
    return rows.map(toAgentRun);
  }

  async listByPrincipal(scopes: readonly RoleScope[], principalId: string, limit: number): Promise<AgentRun[]> {
    if (scopes.length === 0) return [];
    const rows = await this.database
      .selectFrom("agent_run")
      .selectAll()
      .where("principal_id", "=", principalId)
      .where(inScopes(scopes))
      .orderBy("started_at", "desc")
      .orderBy("run_id", "desc")
      .limit(limit)
      .execute();
    return rows.map(toAgentRun);
  }
}
