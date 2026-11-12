import type { Kysely } from "kysely";
import {
  SQLiteAgentRunRepository, agentRunFromRow, sameAgentRunIdentity,
  type AccessDatabase, type AgentRunRepository, type AgentRunStart, type AgentRunIdentity, type AgentRunStatus, type AgentRunRecordResult,
  type RoleScope,
} from "@compass/access";

/** 不変の実行identityとrunning状態をUPDATEの条件へ含め、終了済みの実行を再開しない。 */
export class D1AgentRunRepository implements AgentRunRepository {
  private readonly reader: Pick<AgentRunRepository, "listLatest" | "listByPrincipal">;

  constructor(private readonly database: Kysely<AccessDatabase>, private readonly clock: () => number = Date.now) {
    this.reader = new SQLiteAgentRunRepository(database, clock);
  }

  async start(input: AgentRunStart): Promise<AgentRunRecordResult> {
    const now = this.clock();
    const row = await this.database.insertInto("agent_run").values({
      run_id: input.runId, scope_kind: input.scope.kind, scope_id: input.scope.id, principal_id: input.principalId,
      role: input.role, source: input.source, provider: input.provider,
      work_kind: input.workRef?.kind ?? null, work_id: input.workRef?.id ?? null,
      reporter_kind: input.reporter.kind, reporter_principal_id: input.reporter.principalId,
      status: "running", started_at: now, observed_at: now, stale_at: now + input.staleAfterMs, ended_at: null, reason: null,
    }).onConflict((conflict) => conflict.column("run_id").doNothing()).returningAll().executeTakeFirst();
    if (row) return { kind: "recorded", run: agentRunFromRow(row), changed: true };
    return this.existingResult(input);
  }

  async observe(identity: AgentRunIdentity, staleAfterMs: number): Promise<AgentRunRecordResult> {
    const now = this.clock();
    const row = await this.running(identity).set({ observed_at: now, stale_at: now + staleAfterMs }).returningAll().executeTakeFirst();
    if (row) return { kind: "recorded", run: agentRunFromRow(row), changed: true };
    return this.existingResult(identity);
  }

  async finish(identity: AgentRunIdentity, status: Exclude<AgentRunStatus, "running">, reason: string | null): Promise<AgentRunRecordResult> {
    const now = this.clock();
    const row = await this.running(identity).set({ status, reason, observed_at: now, stale_at: now, ended_at: now }).returningAll().executeTakeFirst();
    if (row) return { kind: "recorded", run: agentRunFromRow(row), changed: true };
    return this.existingResult(identity, status);
  }

  listLatest(scopes: readonly RoleScope[]) { return this.reader.listLatest(scopes); }
  listByPrincipal(scopes: readonly RoleScope[], principalId: string, limit: number) {
    return this.reader.listByPrincipal(scopes, principalId, limit);
  }

  private running(identity: AgentRunIdentity) {
    return this.database.updateTable("agent_run").where("run_id", "=", identity.runId)
      .where("scope_kind", "=", identity.scope.kind).where("scope_id", "=", identity.scope.id)
      .where("principal_id", "=", identity.principalId).where("role", "=", identity.role).where("status", "=", "running");
  }

  private async existingResult(identity: AgentRunIdentity, finishedStatus?: Exclude<AgentRunStatus, "running">): Promise<AgentRunRecordResult> {
    const row = await this.database.selectFrom("agent_run").selectAll().where("run_id", "=", identity.runId).executeTakeFirst();
    if (!row) return { kind: "not_found" };
    const run = agentRunFromRow(row);
    if (!sameAgentRunIdentity(run, identity)) return { kind: "identity_mismatch", run };
    if (finishedStatus !== undefined && run.status !== finishedStatus) return { kind: "already_finished", run };
    return { kind: "recorded", run, changed: false };
  }
}
