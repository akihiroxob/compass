// テストからも読み込むため、他moduleをimportしない純関数だけを置く。
export type Grant = { projectId: string; principalId: string; role: "strategist"; createdAt: number };
export type GrantResponse = { grant: Grant; created: boolean };

export const strategistRole = "strategist" as const;

export const grantsPath = (projectId: string) => `/api/projects/${projectId}/grants`;

/** 取消のpath。principalIdは`/`や空白を含み得るためURLエンコードする。 */
export const revokeGrantPath = (projectId: string, grant: Pick<Grant, "role" | "principalId">) =>
  `${grantsPath(projectId)}/${grant.role}/${encodeURIComponent(grant.principalId)}`;

/** 発行のrequest。Roleはこの画面ではStrategist固定（Web APIと同じ本文）。 */
export const grantInit = (principalId: string): RequestInit => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ principalId, role: strategistRole }),
});

export const revokeInit: RequestInit = { method: "DELETE" };

export const grantNotice = (created: boolean, principalId: string): string =>
  created ? `${principalId} をStrategistに割り当てました。` : `${principalId} は既にStrategistに割り当て済みです。`;
