// テストからも読み込むため、他moduleをimportしない純関数だけを置く。
/** Agent・Runtime向けCredential（Task 37）。secretは発行・rotationの応答だけに含まれ、一覧には無い。 */
export type CredentialKind = "agent" | "runtime";
export type RuntimeScope =
  | "runtime:event:read"
  | "runtime:event:ack"
  | "execution:change:read"
  | "execution:evidence:write"
  | "execution:summary:read";

export type Credential = {
  id: string;
  projectId: string;
  kind: CredentialKind;
  principalId: string;
  scopes: RuntimeScope[];
  prefix: string;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  rotatedFromId: string | null;
};
export type IssuedCredential = { credential: Credential; token: string; previous?: Credential };

export const credentialKindLabels: Record<CredentialKind, string> = { agent: "Agent", runtime: "Runtime" };

export const runtimeScopeOptions: { scope: RuntimeScope; label: string }[] = [
  { scope: "runtime:event:read", label: "Runtimeイベントの取得" },
  { scope: "runtime:event:ack", label: "Runtimeイベントのack" },
  { scope: "execution:change:read", label: "ExecutionのChange取得" },
  { scope: "execution:evidence:write", label: "Execution Evidenceの還流" },
  { scope: "execution:summary:read", label: "還流済みExecution Summaryの取得" },
];
export const allRuntimeScopes = runtimeScopeOptions.map((option) => option.scope);

/** 有効期限の選択肢（serverの許容範囲1〜365日の内側）。既定は90日。 */
export const credentialExpiryOptions = [
  { days: 7, label: "7日" },
  { days: 30, label: "30日" },
  { days: 90, label: "90日" },
  { days: 180, label: "180日" },
  { days: 365, label: "365日" },
] as const;
export const defaultCredentialExpiryDays = 90;

/** rotation後に旧Credentialを併用できる時間の選択肢（server上限は7日）。既定は24時間。 */
export const rotationGraceOptions = [
  { hours: 0, label: "即時に失効" },
  { hours: 1, label: "1時間" },
  { hours: 24, label: "24時間" },
  { hours: 168, label: "7日" },
] as const;
export const defaultRotationGraceHours = 24;

export type CredentialStatus = "active" | "expired" | "revoked";
export const credentialStatus = (credential: Pick<Credential, "expiresAt" | "revokedAt">, now: number): CredentialStatus =>
  credential.revokedAt !== null ? "revoked" : now >= credential.expiresAt ? "expired" : "active";

export const credentialStatusLabels: Record<CredentialStatus, string> = {
  active: "有効",
  expired: "期限切れ",
  revoked: "取消済み",
};

export const credentialsPath = (projectId: string, credentialId?: string) =>
  `/api/projects/${projectId}/credentials${credentialId ? `/${credentialId}` : ""}`;
export const rotateCredentialPath = (projectId: string, credentialId: string) =>
  `${credentialsPath(projectId, credentialId)}/rotate`;

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

/** Agent Credentialにはscopeを送らない（認可はRole Grant）。 */
export const issueCredentialInit = (
  kind: CredentialKind,
  principalId: string,
  scopes: readonly RuntimeScope[],
  expiresInDays: number,
): RequestInit =>
  jsonRequest("POST", kind === "runtime" ? { kind, principalId, scopes, expiresInDays } : { kind, principalId, expiresInDays });

export const rotateCredentialInit = (graceHours: number): RequestInit => jsonRequest("POST", { graceHours });
export const revokeCredentialInit: RequestInit = { method: "DELETE" };
