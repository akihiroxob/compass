/**
 * Agent・外部Runtime向けのCompass発行Credential（Task 37）。Human Session（Google OIDC）とは別の認証経路。
 * secretは発行・rotationの応答で一度だけ返し、ここには持たない（保存はSHA-256だけ）。
 *
 * - `agent`: 解決したPrincipalに対し、既存のProject Role Grantで認可する。
 * - `runtime`: Role Grantを使わず、Credentialに付けた`scopes`だけで認可する。
 *
 * どちらも発行したProjectに束縛する。同じPrincipalを別ProjectのGrantと共有させない（repositoryが同一transactionで検査する）。
 */
export const credentialKinds = ["agent", "runtime"] as const;
export type CredentialKind = (typeof credentialKinds)[number];

/** Runtime Credentialのscope。Runtime向けの各入口が1つを要求する。 */
export const runtimeScopes = [
  "runtime:event:read",
  "runtime:event:ack",
  "execution:change:read",
  "execution:evidence:write",
  "execution:summary:read",
] as const;
export type RuntimeScope = (typeof runtimeScopes)[number];

export const credentialDefaultTtlDays = 90;
export const credentialMinTtlDays = 1;
export const credentialMaxTtlDays = 365;
/** rotation時に旧Credentialを併用できる時間。0は即時失効。 */
export const credentialDefaultRotationGraceHours = 24;
export const credentialMaxRotationGraceHours = 7 * 24;

export type AccessCredential = {
  id: string;
  projectId: string;
  kind: CredentialKind;
  principalId: string;
  /** `agent`は常に空。 */
  scopes: RuntimeScope[];
  /** 一覧で見分けるための先頭部分（secretの大半は含まない）。 */
  prefix: string;
  expiresAt: number;
  revokedAt: number | null;
  lastUsedAt: number | null;
  createdAt: number;
  createdByHumanUserId: string;
  /** rotationで置き換えた元のCredential。 */
  rotatedFromId: string | null;
};

export type CredentialStatus = "active" | "expired" | "revoked";

export const credentialStatus = (credential: Pick<AccessCredential, "expiresAt" | "revokedAt">, now: number): CredentialStatus =>
  credential.revokedAt !== null ? "revoked" : credential.expiresAt <= now ? "expired" : "active";
