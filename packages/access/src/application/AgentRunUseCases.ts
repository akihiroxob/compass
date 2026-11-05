import { z } from "zod";
import { ConflictError, ForbiddenError, NotFoundError, UnauthenticatedError, parseWith } from "@compass/shared";
import {
  agentRunObservation,
  agentRunSources,
  agentRunStaleAfterSeconds,
  agentRunWorkKinds,
  redactCredentials,
  type AgentRun,
  type AgentRunIdentity,
  type AgentRunObservation,
  type AgentRunRecordResult,
  type AgentRunReporter,
  type AgentRunRepository,
} from "../domain/AgentRun.ts";
import { projectRoles, type ProjectRole } from "../domain/ProjectRole.ts";
import type { ProjectGrantRepository } from "../domain/ProjectGrantRepository.ts";
import { isRoleInScope, type RoleScope, type WorkspaceRole } from "../domain/RoleScope.ts";
import type { WorkspaceGrantRepository } from "../domain/WorkspaceGrant.ts";
import { principalIdSchema } from "./projectGrantSchema.ts";
import type { Caller } from "./RuntimeAuthorizationService.ts";

/** 報告元が生成する一意なrun ID。表示・ログに出すため、認証情報を含められない文字種に限る。 */
const runIdSchema = z.string().trim().min(8).max(200).regex(/^[A-Za-z0-9._:-]+$/, "runId may contain letters, digits, '.', '_', ':' and '-' only")
  .refine((value) => !value.includes("cmp_"), "runId must not be a credential");

const recordAgentRunSchema = z
  .object({
    runId: runIdSchema,
    scope: z.object({ kind: z.enum(["workspace", "project"]), id: z.string().trim().min(1).max(200) }).strict(),
    event: z.enum(["started", "observed", "finished"]),
    source: z.enum(agentRunSources),
    /** Runtime Credentialで報告するときだけ指定する（Agent CredentialはBearerのPrincipalとactiveRole）。 */
    principalId: principalIdSchema.optional(),
    role: z.enum(projectRoles).optional(),
    provider: z.string().trim().min(1).max(100).optional(),
    workRef: z.object({ kind: z.enum(agentRunWorkKinds), id: z.string().trim().min(1).max(200) }).strict().optional(),
    staleAfterSeconds: z.number().int().min(agentRunStaleAfterSeconds.min).max(agentRunStaleAfterSeconds.max).optional(),
    result: z.enum(["succeeded", "failed"]).optional(),
    reason: z.string().trim().max(1_000).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (input.event === "finished" && input.result === undefined) {
      context.addIssue({ code: "custom", path: ["result"], message: "result is required when event is finished" });
    }
    if (input.event !== "finished" && input.result !== undefined) {
      context.addIssue({ code: "custom", path: ["result"], message: "result is accepted only when event is finished" });
    }
  });

export type RecordAgentRunInput = z.input<typeof recordAgentRunSchema>;
export type AgentRunView = AgentRun & { observation: AgentRunObservation };
const view = (run: AgentRun, now: number): AgentRunView => ({ ...run, observation: agentRunObservation(run, now) });

const scopeDetails = (scope: RoleScope) => (scope.kind === "workspace" ? { workspaceId: scope.id } : { projectId: scope.id });
const sameScope = (a: RoleScope, b: RoleScope) => a.kind === b.kind && a.id === b.id;

/**
 * Agentの実行観測の記録（MCP `record_agent_run`）。誰の・どのRoleの・どのscopeの実行かはServerが認証情報とGrantで確定し、
 * 報告元の申告だけでは決めない。
 * - Agent Credential・trusted-localのAgent名: PrincipalはBearer、Roleは`X-Compass-Active-Role`（必須）。Agent Credentialは発行scopeだけ。
 * - Runtime Credential: `agent:run:write` scopeとCredentialのscopeの一致を要求し、指定したPrincipalがそのscopeでそのRoleのGrantを持つ実行だけ。
 * どちらも、記録するRoleはscopeが受け付けるRole（WorkspaceはDirection Role、ProjectはExecution Role）で、そのGrantが必要。
 */
export class RecordAgentRunUseCase {
  constructor(
    private readonly runs: AgentRunRepository,
    private readonly workspaceGrants: Pick<WorkspaceGrantRepository, "hasRole">,
    private readonly projectGrants: Pick<ProjectGrantRepository, "hasRole">,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(caller: Caller, activeRole: ProjectRole | null, rawInput: unknown): Promise<{ run: AgentRunView; recorded: boolean }> {
    if (caller === null) throw new UnauthenticatedError("Authorization: Bearer <Agent or Runtime Credential> is required");
    const input = parseWith(recordAgentRunSchema, rawInput, "Agent run");
    const scope: RoleScope = input.scope;
    const { principalId, role, reporter } = this.subjectOf(caller, activeRole, input, scope);
    if (!isRoleInScope(scope.kind, role)) {
      throw new ForbiddenError(`The ${role} Role does not run in a ${scope.kind} scope`, { ...scopeDetails(scope), requiredRole: role });
    }
    const granted = scope.kind === "workspace"
      ? await this.workspaceGrants.hasRole(scope.id, principalId, role as WorkspaceRole)
      : await this.projectGrants.hasRole(scope.id, principalId, role);
    if (!granted) {
      throw new ForbiddenError("The Principal does not have the Role Grant of this run in this scope", { ...scopeDetails(scope), requiredRole: role });
    }
    const identity: AgentRunIdentity = { runId: input.runId, scope, principalId, role };
    const staleAfterMs = (input.staleAfterSeconds ?? agentRunStaleAfterSeconds.default) * 1000;
    const result: AgentRunRecordResult = input.event === "started"
      ? await this.runs.start({ ...identity, source: input.source, provider: input.provider ? redactCredentials(input.provider) : null, workRef: input.workRef ? { ...input.workRef, id: redactCredentials(input.workRef.id) } : null, reporter, staleAfterMs })
      : input.event === "observed"
        ? await this.runs.observe(identity, staleAfterMs)
        : await this.runs.finish(identity, input.result!, input.reason ? redactCredentials(input.reason) : null);
    if (result.kind === "not_found") throw new NotFoundError(`Agent run ${input.runId} was not found (report started first)`);
    // 別のPrincipal・scope・Roleで記録済みのrun IDは上書きしない（scopeを越えた書換え・重複を防ぐ）。相手の内容は返さない。
    if (result.kind === "identity_mismatch") {
      throw new ConflictError(`Agent run ${input.runId} is recorded for another Principal, scope or Role`, { conflict: "AGENT_RUN_IDENTITY_MISMATCH" });
    }
    if (result.kind === "already_finished") {
      throw new ConflictError(`Agent run ${input.runId} already finished as ${result.run.status}`, { conflict: "AGENT_RUN_FINISHED", status: result.run.status });
    }
    return { run: view(result.run, this.clock()), recorded: result.changed };
  }

  private subjectOf(
    caller: Exclude<Caller, null>,
    activeRole: ProjectRole | null,
    input: z.output<typeof recordAgentRunSchema>,
    scope: RoleScope,
  ): { principalId: string; role: ProjectRole; reporter: AgentRunReporter } {
    if (typeof caller !== "string" && caller.kind === "runtime") {
      if (!sameScope(caller.scope, scope)) {
        throw new ForbiddenError(`This Runtime Credential is not valid for this ${scope.kind === "workspace" ? "Workspace" : "Project"}`, {
          ...scopeDetails(scope), requiredScope: "agent:run:write",
        });
      }
      if (!caller.scopes.includes("agent:run:write")) {
        throw new ForbiddenError("This Runtime Credential does not have the agent:run:write scope", { ...scopeDetails(scope), requiredScope: "agent:run:write" });
      }
      if (input.principalId === undefined || input.role === undefined) {
        throw new ForbiddenError("A Runtime Credential must name the principalId and role of the run", scopeDetails(scope));
      }
      return { principalId: input.principalId, role: input.role, reporter: { kind: "runtime", principalId: caller.principalId } };
    }
    const principalId = typeof caller === "string" ? caller : caller.principalId;
    if (typeof caller !== "string" && !sameScope(caller.scope, scope)) {
      throw new ForbiddenError("This Agent Credential is not valid for this scope", scopeDetails(scope));
    }
    if (activeRole === null) throw new ForbiddenError("Recording an Agent run requires X-Compass-Active-Role", scopeDetails(scope));
    if ((input.principalId !== undefined && input.principalId !== principalId) || (input.role !== undefined && input.role !== activeRole)) {
      throw new ForbiddenError("An Agent can record only its own run with its activeRole", scopeDetails(scope));
    }
    return { principalId, role: activeRole, reporter: { kind: "agent", principalId } };
  }
}

const listAgentRunsSchema = z.object({ principalId: principalIdSchema.optional() }).strict();
export const agentRunHistoryLimit = 20;

/**
 * Workspaceと所属Projectの実行観測（Human向けWeb API。認可は呼出側がWorkspace Membershipで行う）。`principalId`を指定すると
 * そのPrincipalの新しい順の履歴（最大20件）、無ければPrincipal・scope・Roleごとの最新の実行。`asOf`はServerの読取時刻で、
 * `observation`（実行中・観測途絶・正常終了・異常終了）はこの時刻で判定する。
 */
export class ListWorkspaceAgentRunsUseCase {
  constructor(
    private readonly projectIdsOf: (workspaceId: string) => Promise<string[]>,
    private readonly runs: AgentRunRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(workspaceId: string, query: unknown = {}): Promise<{ asOf: number; runs: AgentRunView[] }> {
    const { principalId } = parseWith(listAgentRunsSchema, query, "Agent run query");
    const projectIds = await this.projectIdsOf(workspaceId);
    const scopes: RoleScope[] = [{ kind: "workspace", id: workspaceId }, ...projectIds.map((id) => ({ kind: "project" as const, id }))];
    const runs = principalId === undefined ? await this.runs.listLatest(scopes) : await this.runs.listByPrincipal(scopes, principalId, agentRunHistoryLimit);
    const asOf = this.clock();
    return { asOf, runs: runs.map((run) => view(run, asOf)) };
  }
}
