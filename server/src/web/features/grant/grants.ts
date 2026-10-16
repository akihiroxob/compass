// テストからも読み込むため、他moduleをimportしない純関数だけを置く。
export type GrantRole = "strategist" | "researcher" | "manager" | "worker" | "reviewer" | "evaluator" | "runtime";
/** Project Grantは`projectId`、Workspace Grant（Direction Role）は`workspaceId`を持つ。 */
export type Grant = { projectId?: string; workspaceId?: string; principalId: string; role: GrantRole; createdAt: number };
/** Grantを発行するscope。Workspace GrantとProject Grantは互いに継承しない。 */
export type GrantScope = { kind: "workspace" | "project"; id: string };
export type GrantResponse = { grant: Grant; created: boolean };

export const strategistRole = "strategist" as const;

export const grantRoleLabels: Record<GrantRole, string> = {
  strategist: "Strategist",
  researcher: "Researcher",
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  evaluator: "Evaluator",
  runtime: "Runtime",
};

/** Project設定で表示するRole。旧Direction Grantは参照・取消だけを残す。 */
export const agentRoles = ["strategist", "researcher", "manager", "worker", "reviewer", "evaluator"] as const satisfies readonly GrantRole[];
export const projectGrantRoles = ["manager", "worker", "reviewer"] as const;
export const canGrantProjectRole = (role: GrantRole) => projectGrantRoles.some((candidate) => candidate === role);
/** Workspace設定で割当・取消するDirection Role。Execution Role（manager等）はWorkspaceには割り当てない。 */
export const workspaceGrantRoles = ["strategist", "researcher", "evaluator"] as const satisfies readonly AgentRole[];
/** scopeで表示するRole。Projectは旧Direction Grantの参照・取消を含む6種、WorkspaceはDirection Roleの3種。 */
export const scopeGrantRoles = (scope: GrantScope): readonly AgentRole[] => (scope.kind === "workspace" ? workspaceGrantRoles : agentRoles);
/** scopeで新規に割り当てられるRoleか。 */
export const canGrantInScope = (scope: GrantScope, role: GrantRole) =>
  scope.kind === "workspace" ? workspaceGrantRoles.some((candidate) => candidate === role) : canGrantProjectRole(role);
/** 取消確認の復元説明。旧Direction GrantはProjectから再発行できないため、元に戻せるとは伝えない。 */
export const revokeRecoveryNote = (scope: GrantScope, role: GrantRole) =>
  canGrantInScope(scope, role) ? "再度割り当てて元に戻せます。" : "WorkspaceのRoleのため、Projectからは再度割り当てできません。";
export type AgentRole = (typeof agentRoles)[number];
/** Roleの責務の要約（Project設定のRole割当・WorkspaceのAgent画面）。正本はGit管理のRole Definition（`roles/<role>.md`）。 */
export const agentRoleDescriptions: Record<AgentRole, string> = {
  strategist: "Intentから次に達成すべきOutcomeを判断します。",
  researcher: "Research Requestの調査結果を登録します。",
  manager: "確定したOutcomeをStory・Taskへ落とし込み、最終受入します。",
  worker: "Taskを引き受けて実装します。",
  reviewer: "完了したTaskを実装・検証の観点でレビューします。",
  evaluator: "Outcomeの成功条件を、還流したExecution Evidenceで評価します。",
};
/** 「設定」viewのRole行のanchor。概要の「次の行動」から辿る。 */
export const agentRoleAnchorId = (role: GrantRole) => `agent-role-${role}`;

/** 読込・操作でscopeが見つからない（閲覧権限が無い場合を含む）ときの表示。 */
export const scopeNotFoundMessage = (scope: GrantScope) => (scope.kind === "workspace" ? "Workspaceが見つかりません。" : "Projectが見つかりません。");

export const scopeGrantsPath = (scope: GrantScope) => `/api/${scope.kind === "workspace" ? "workspaces" : "projects"}/${scope.id}/grants`;
export const grantsPath = (projectId: string) => scopeGrantsPath({ kind: "project", id: projectId });

/** 取消のpath。principalIdは`/`や空白を含み得るためURLエンコードする。 */
export const scopeRevokeGrantPath = (scope: GrantScope, grant: Pick<Grant, "role" | "principalId">) =>
  `${scopeGrantsPath(scope)}/${grant.role}/${encodeURIComponent(grant.principalId)}`;
export const revokeGrantPath = (projectId: string, grant: Pick<Grant, "role" | "principalId">) =>
  scopeRevokeGrantPath({ kind: "project", id: projectId }, grant);

/** 発行のrequest（Web APIと同じ本文）。 */
export const grantInit = (principalId: string, role: GrantRole): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ principalId, role }),
});

export const revokeInit: RequestInit = { method: "DELETE" };

export const grantNotice = (created: boolean, principalId: string, role: GrantRole): string => {
  const label = grantRoleLabels[role];
  return created ? `${principalId} を${label}に割り当てました。` : `${principalId} は既に${label}に割り当て済みです。`;
};
