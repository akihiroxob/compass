// テストからも読み込むため、他moduleをimportしない純関数だけを置く。
export type GrantRole = "strategist" | "researcher";
export type Grant = { projectId: string; principalId: string; role: GrantRole; createdAt: number };
export type GrantResponse = { grant: Grant; created: boolean };

export const strategistRole = "strategist" as const;

export const grantRoleLabels: Record<GrantRole, string> = { strategist: "Strategist", researcher: "Researcher" };

export const grantsPath = (projectId: string) => `/api/projects/${projectId}/grants`;

/** 取消のpath。principalIdは`/`や空白を含み得るためURLエンコードする。 */
export const revokeGrantPath = (projectId: string, grant: Pick<Grant, "role" | "principalId">) =>
  `${grantsPath(projectId)}/${grant.role}/${encodeURIComponent(grant.principalId)}`;

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
