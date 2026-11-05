// WorkspaceのAgent管理（UI-E1）。Principalを軸に、Role・担当範囲（Grantのscope）・Grant・Credential・現在の作業（Claim）を別の状態として扱い、
// いずれからもAgentプロセスの稼働を推測しない。テストからも読み込むため、純関数のmodule以外をimportしない。
import { credentialStatus, type Credential, type CredentialStatus } from "../credential/model.ts";
import type { ClaimHolderStatus, ExecutionTask } from "../execution/model.ts";
import type { AgentRole } from "../grant/model.ts";

/** Workspace Direction Role。Workspace Grantで担い、Work Claimを持たない。 */
export const workspaceAgentRoles = ["strategist", "researcher", "evaluator"] as const satisfies readonly AgentRole[];
/** Project Execution Role。Project Grantで担い、TaskのClaimを保持する。ManagerはProjectのRoleで、Workspace Roleではない。 */
export const projectAgentRoles = ["manager", "worker", "reviewer"] as const satisfies readonly AgentRole[];
/** Agentの担うRole（Runtimeを除く）。Projectに残る旧Direction Grantも、黙って隠さずGrantとして出す。 */
const agentRoleOrder: readonly AgentRole[] = [...workspaceAgentRoles, ...projectAgentRoles];
const isAgentRole = (role: string): role is AgentRole => agentRoleOrder.some((candidate) => candidate === role);

/** `GET /api/workspaces/:workspaceId/grants`・`GET /api/projects/:projectId/grants`の共通部分。 */
export type ScopeGrant = { principalId: string; role: string; createdAt: number };

export const agentRolePath = (role: AgentRole) => `/api/agent-roles/${role}`;

/** `GET /api/agent-roles/:role`。Git管理のRole Definitionと、Roleが参照するSkillのmetadata（本文はMCPの`get_skill_context`）。 */
export type AgentRoleDefinition = {
  role: { name: AgentRole; path: string; content: string };
  skills: { name: string; description: string; status: "draft" | "active" | "deprecated"; version: number; path: string; requiredKnowledge: string[]; requiredTools: string[] }[];
  /** 資産を読んだGit revision。未commitの変更があれば`dirty`。 */
  source: { revision: string | null; dirty: boolean | null };
};

/** Grant・Credentialのscope。Workspace GrantとProject Grant、Workspace CredentialとProject Credentialは互いに継承しない。 */
export type AgentScope = { kind: "workspace" | "project"; id: string; name: string };
export const sameScope = (a: Pick<AgentScope, "kind" | "id">, b: Pick<AgentScope, "kind" | "id">) => a.kind === b.kind && a.id === b.id;

/** Grant 1件（scope × Role）。 */
export type AgentGrant = { scope: AgentScope; role: AgentRole; createdAt: number };

/** Principalが持つAgent Credentialの代表の状態。`none`は未発行。 */
export type PrincipalCredential = { status: CredentialStatus | "none"; expiresAt: number | null };

/** Principalが保持中のClaim 1件。状態から、Claimを取得したRoleの段階（作業・レビュー・受入）が分かる。 */
export type PrincipalClaim = { taskId: string; projectId: string; projectName: string; title: string; status: ClaimHolderStatus; expiresAt: number };

export type WorkspaceAgent = {
  principalId: string;
  /** Grant。Workspaceを先頭に、Projectは一覧の順、同じscopeではRoleの順。空ならGrantは無い（Claim・Credentialだけが残っている）。 */
  grants: AgentGrant[];
  /** Grantの重複を除いたRole。 */
  roles: AgentRole[];
  /** Grantのscope（担当範囲）。Workspaceを先頭に、Projectは一覧の順。 */
  scopes: AgentScope[];
  /** このPrincipalのAgent Credential（Workspace・全Project）。`null`はCredentialを参照する権限が無く、状態を判断しない。 */
  credentials: (Credential & { scopeName: string })[] | null;
  credential: PrincipalCredential | null;
  claims: PrincipalClaim[];
};

export type WorkspaceAgents = {
  principals: WorkspaceAgent[];
  /** Claimの期限が切れ、Workerの再取得待ちの作業中Task。担当中ではない。 */
  reclaimableCount: number;
};

/** 読み込めたProject 1件分の入力。 */
export type ProjectAgentSource = { project: { id: string; name: string }; grants: readonly ScopeGrant[]; credentials: readonly Credential[] | null; tasks: readonly ExecutionTask[] };

const credentialRank: Record<PrincipalCredential["status"], number> = { active: 3, expired: 2, revoked: 1, none: 0 };

/**
 * PrincipalのAgent Credentialの状態。有効なものがあれば有効（最も遅い期限）、無ければ期限切れ・取消済み・未発行の順で代表を選ぶ。
 * Runtime Credentialは含めない（RuntimeはAgent Roleを担わない）。
 */
export const principalCredential = (principalId: string, credentials: readonly Credential[], now: number): PrincipalCredential => {
  let best: PrincipalCredential = { status: "none", expiresAt: null };
  for (const credential of credentials) {
    if (credential.kind !== "agent" || credential.principalId !== principalId) continue;
    const status = credentialStatus(credential, now);
    const better = credentialRank[status] > credentialRank[best.status] || (status === best.status && credential.expiresAt > (best.expiresAt ?? 0));
    if (better) best = { status, expiresAt: credential.expiresAt };
  }
  return best;
};

/**
 * Workspaceと読み込めた全ProjectのGrant・Agent Credential・Claimを、Principalごとにまとめる。
 * - Grant・期限内のClaim・有効なAgent CredentialのいずれかがあるPrincipalを出す（取消済みCredentialだけ・Runtimeは出さない）
 * - Workspace GrantはDirection Role、Project GrantはRuntime以外の全Role（旧Direction Grantを含む）を数える
 * - `workspaceCredentials`が`null`（参照権限なし）ならCredentialを判断しない
 */
export const summarizeWorkspaceAgents = (input: {
  workspace: { id: string; name: string };
  workspaceGrants: readonly ScopeGrant[];
  workspaceCredentials: readonly Credential[] | null;
  projects: readonly ProjectAgentSource[];
  now: number;
  /** 観測だけが残るPrincipalも履歴へ辿れるようにする。担当Role・scopeはGrantからだけ決める。 */
  observedPrincipalIds?: readonly string[];
}): WorkspaceAgents => {
  const { workspace, workspaceGrants, workspaceCredentials, projects, now } = input;
  const workspaceScope: AgentScope = { kind: "workspace", id: workspace.id, name: workspace.name };
  const sources = [
    { scope: workspaceScope, grants: workspaceGrants.filter((grant) => workspaceAgentRoles.some((role) => role === grant.role)), credentials: workspaceCredentials, tasks: [] as readonly ExecutionTask[] },
    ...projects.map((source) => ({ scope: { kind: "project", ...source.project } as AgentScope, grants: source.grants, credentials: source.credentials, tasks: source.tasks })),
  ];
  const showCredentials = workspaceCredentials !== null && projects.every((source) => source.credentials !== null);
  const grants = new Map<string, AgentGrant[]>();
  const credentials = new Map<string, (Credential & { scopeName: string })[]>();
  const claims = new Map<string, PrincipalClaim[]>();
  const principalIds = new Set<string>(input.observedPrincipalIds);
  const push = <T,>(map: Map<string, T[]>, key: string, value: T) => map.set(key, [...(map.get(key) ?? []), value]);
  let reclaimableCount = 0;
  for (const source of sources) {
    for (const role of agentRoleOrder) {
      for (const grant of source.grants) {
        if (grant.role !== role || !isAgentRole(grant.role)) continue;
        push(grants, grant.principalId, { scope: source.scope, role, createdAt: grant.createdAt });
        principalIds.add(grant.principalId);
      }
    }
    for (const credential of source.credentials ?? []) {
      if (credential.kind !== "agent") continue;
      push(credentials, credential.principalId, { ...credential, scopeName: source.scope.name });
      if (credentialStatus(credential, now) === "active") principalIds.add(credential.principalId);
    }
    for (const task of source.tasks) {
      const claim = task.activeClaim;
      if (claim === null || claim.expiresAt <= now) {
        if (task.status === "doing" && (task.reclaimable || claim !== null)) reclaimableCount += 1;
        continue;
      }
      if (task.status !== "doing" && task.status !== "in_review" && task.status !== "wait_accept") continue;
      push(claims, claim.principalId, { taskId: task.id, projectId: task.projectId, projectName: source.scope.name, title: task.title, status: task.status, expiresAt: claim.expiresAt });
      principalIds.add(claim.principalId);
    }
  }
  const principals = [...principalIds].sort((a, b) => a.localeCompare(b)).map((principalId): WorkspaceAgent => {
    const own = grants.get(principalId) ?? [];
    const ownCredentials = credentials.get(principalId) ?? [];
    return {
      principalId,
      grants: own,
      roles: agentRoleOrder.filter((role) => own.some((grant) => grant.role === role)),
      scopes: sources.map((source) => source.scope).filter((scope) => own.some((grant) => sameScope(grant.scope, scope))),
      credentials: showCredentials ? ownCredentials : null,
      credential: showCredentials ? principalCredential(principalId, ownCredentials, now) : null,
      claims: (claims.get(principalId) ?? []).sort((a, b) => a.expiresAt - b.expiresAt),
    };
  });
  return { principals, reclaimableCount };
};

/** 一覧の担当範囲の1行。Workspace担当は「Workspace」、Projectは先頭の名前と残りの件数。全件は詳細で出す。 */
export const scopeSummary = (scopes: readonly AgentScope[]): { label: string; others: number } | null =>
  scopes.length === 0 ? null : { label: scopes[0].kind === "workspace" ? "Workspace" : scopes[0].name, others: scopes.length - 1 };

/** Claimを取得したRoleの段階。作業中はWorker、レビュー待ちはReviewer、受入待ちはManagerのClaim。 */
export const claimStageRoles: Record<ClaimHolderStatus, AgentRole> = { doing: "worker", in_review: "reviewer", wait_accept: "manager" };

/** 保持中のClaimのうち、そのProjectでそのRoleのGrantが今は無いもの（Claim取得後にGrantが取り消された等）。 */
export const claimsWithoutGrant = (agent: Pick<WorkspaceAgent, "grants" | "claims">): PrincipalClaim[] =>
  agent.claims.filter((claim) => !agent.grants.some((grant) => grant.scope.kind === "project" && grant.scope.id === claim.projectId && grant.role === claimStageRoles[claim.status]));

/**
 * Agent Credentialを発行できるscope。Agent Credentialは発行したscopeに束縛され、別scopeのGrant・有効なAgent Credentialを持つ
 * Principalには発行できない（serverの`PRINCIPAL_BOUND_ELSEWHERE`）。
 * - `single`: Grant・有効なCredentialのscopeが1つ。そのscopeで発行できる
 * - `multiple`: 複数のscopeにある。既存Grantは削除せず、発行はできない（trusted-localのAgent名での接続だけ）
 * - `none`: Grantも有効なCredentialも無い
 */
export type CredentialBinding = { kind: "single"; scope: AgentScope } | { kind: "multiple"; scopes: AgentScope[] } | { kind: "none" };
export const credentialBinding = (agent: Pick<WorkspaceAgent, "scopes" | "credentials">, now: number): CredentialBinding => {
  const scopes = [...agent.scopes];
  for (const credential of agent.credentials ?? []) {
    if (credentialStatus(credential, now) !== "active" || scopes.some((scope) => sameScope(scope, credential.scope))) continue;
    scopes.push({ ...credential.scope, name: credential.scopeName });
  }
  return scopes.length === 0 ? { kind: "none" } : scopes.length === 1 ? { kind: "single", scope: scopes[0] } : { kind: "multiple", scopes };
};

/** scopeごとのGrantとAgent Credential（詳細の表示単位）。Grantの無いscopeのCredential（取消済み等）も落とさない。 */
export const agentScopeGroups = (agent: Pick<WorkspaceAgent, "grants" | "scopes" | "credentials">) => {
  const scopes = [...agent.scopes];
  for (const credential of agent.credentials ?? []) {
    if (!scopes.some((scope) => sameScope(scope, credential.scope))) scopes.push({ ...credential.scope, name: credential.scopeName });
  }
  return scopes.map((scope) => ({
    scope,
    grants: agent.grants.filter((grant) => sameScope(grant.scope, scope)),
    credentials: agent.credentials?.filter((credential) => sameScope(credential.scope, scope)) ?? null,
  }));
};

export const principalCredentialLabels: Record<PrincipalCredential["status"], string> = {
  active: "有効",
  expired: "期限切れ",
  revoked: "取消済み",
  none: "未発行",
};

/** 登録（Grant付与）の入力の検査。serverも同じ規則を検証する。 */
export const registrationIssues = (input: { principalId: string; role: AgentRole | ""; projectIds: readonly string[] }): string[] => {
  const issues: string[] = [];
  if (input.principalId.trim() === "") issues.push("Agent名を入力してください。");
  if (input.role === "") issues.push("Roleを選んでください。");
  else if (projectAgentRoles.some((role) => role === input.role) && input.projectIds.length === 0) issues.push("担当するProjectを1つ以上選んでください。");
  return issues;
};
