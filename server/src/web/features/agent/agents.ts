// WorkspaceのAgent画面（S11-02）。Grant（担当できるRole）・Credential（接続の資格）・Claim（保持中のTask）を別の状態として扱い、
// いずれからもAgentプロセスの稼働を推測しない。テストからも読み込むため、純関数のmodule以外をimportしない。
import { credentialStatus, type Credential, type CredentialStatus } from "../credential/model.ts";
import type { ClaimHolderStatus, ExecutionTask } from "../execution/model.ts";
import type { AgentRole } from "../grant/model.ts";

/** Workspace Direction Role。Workspace Grantで担い、Work Claimを持たない。 */
export const workspaceAgentRoles = ["strategist", "researcher", "evaluator"] as const satisfies readonly AgentRole[];
/** Project Execution Role。Project Grantで担い、TaskのClaimを保持する。ManagerはProjectのRoleで、Workspace Roleではない。 */
export const projectAgentRoles = ["manager", "worker", "reviewer"] as const satisfies readonly AgentRole[];

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

/** Principalが持つAgent Credentialの状態。`none`は未発行。Credentialを参照できない利用者には判定しない（`null`）。 */
export type PrincipalCredential = { status: CredentialStatus | "none"; expiresAt: number | null };

/** Principalが保持中のClaim 1件。状態から、Claimを取得したRoleの段階（作業・レビュー・受入）が分かる。 */
export type PrincipalClaim = { taskId: string; projectId: string; title: string; status: ClaimHolderStatus; expiresAt: number };

export type AgentPrincipal = {
  principalId: string;
  /** このscopeで担当できるRole（Grant）。空ならGrantは無い（Claim・Credentialだけが残っている）。 */
  roles: AgentRole[];
  /** `null`はCredentialを参照する権限が無く、状態を判断しない。 */
  credential: PrincipalCredential | null;
  /** `null`はClaimを持たないscope（Workspace Direction Role）。空配列は保持中のClaimが無い。 */
  claims: PrincipalClaim[] | null;
};

export type ScopeAgents = {
  roles: { role: AgentRole; principalIds: string[] }[];
  principals: AgentPrincipal[];
  /** Claimの期限が切れ、Workerの再取得待ちの作業中Task。担当中ではない。Claimを持たないscopeは`null`。 */
  reclaimableCount: number | null;
};

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

/** `now`時点で期限内のClaimを持つTask。期限切れの作業中Taskは再取得待ちとして数える（serverの`reclaimable`と同じ判定）。 */
const heldClaims = (tasks: readonly ExecutionTask[], now: number) => {
  const claims = new Map<string, PrincipalClaim[]>();
  let reclaimableCount = 0;
  for (const task of tasks) {
    const claim = task.activeClaim;
    if (claim === null || claim.expiresAt <= now) {
      if (task.status === "doing" && (task.reclaimable || claim !== null)) reclaimableCount += 1;
      continue;
    }
    if (task.status !== "doing" && task.status !== "in_review" && task.status !== "wait_accept") continue;
    const list = claims.get(claim.principalId) ?? [];
    list.push({ taskId: task.id, projectId: task.projectId, title: task.title, status: task.status, expiresAt: claim.expiresAt });
    claims.set(claim.principalId, list);
  }
  for (const list of claims.values()) list.sort((a, b) => a.expiresAt - b.expiresAt);
  return { claims, reclaimableCount };
};

/**
 * 1つのscope（WorkspaceまたはProject）のAgentを、RoleごとのGrantとPrincipalごとの状態にまとめる。
 * - `roles`以外のRoleのGrant（Projectに残る旧Direction Grant等）は数えない
 * - `credentials`が`null`（参照権限なし）ならCredentialを判断しない。有効なAgent Credentialだけを持つPrincipalも一覧に出す
 * - `tasks`が`null`のscope（Workspace）はClaimを持たないものとして扱い、Claimを作らない
 */
export const summarizeScopeAgents = (input: {
  roles: readonly AgentRole[];
  grants: readonly ScopeGrant[];
  credentials: readonly Credential[] | null;
  tasks: readonly ExecutionTask[] | null;
  now: number;
}): ScopeAgents => {
  const { roles, grants, credentials, tasks, now } = input;
  const inScope = grants.filter((grant) => roles.some((role) => role === grant.role)) as (ScopeGrant & { role: AgentRole })[];
  const held = tasks === null ? null : heldClaims(tasks, now);
  const principalIds = new Set(inScope.map((grant) => grant.principalId));
  for (const principalId of held?.claims.keys() ?? []) principalIds.add(principalId);
  for (const credential of credentials ?? []) {
    if (credential.kind === "agent" && credentialStatus(credential, now) === "active") principalIds.add(credential.principalId);
  }
  const principals = [...principalIds].sort((a, b) => a.localeCompare(b)).map((principalId): AgentPrincipal => ({
    principalId,
    roles: roles.filter((role) => inScope.some((grant) => grant.principalId === principalId && grant.role === role)),
    credential: credentials === null ? null : principalCredential(principalId, credentials, now),
    claims: held === null ? null : held.claims.get(principalId) ?? [],
  }));
  return {
    roles: roles.map((role) => ({ role, principalIds: inScope.filter((grant) => grant.role === role).map((grant) => grant.principalId).sort((a, b) => a.localeCompare(b)) })),
    principals,
    reclaimableCount: held === null ? null : held.reclaimableCount,
  };
};

/** Claimを取得したRoleの段階。作業中はWorker、レビュー待ちはReviewer、受入待ちはManagerのClaim。 */
export const claimStageRoles: Record<ClaimHolderStatus, AgentRole> = { doing: "worker", in_review: "reviewer", wait_accept: "manager" };

/** 保持中のClaimのうち、そのRoleのGrantが今は無いもの（Claim取得後にGrantが取り消された等）。 */
export const claimsWithoutGrant = (principal: Pick<AgentPrincipal, "roles" | "claims">): PrincipalClaim[] =>
  (principal.claims ?? []).filter((claim) => !principal.roles.includes(claimStageRoles[claim.status]));

export const principalCredentialLabels: Record<PrincipalCredential["status"], string> = {
  active: "有効",
  expired: "期限切れ",
  revoked: "取消済み",
  none: "未発行",
};
