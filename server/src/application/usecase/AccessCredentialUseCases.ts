import { randomUUID } from "node:crypto";
import type { AccessCredential, CredentialKind } from "../../domain/model/AccessCredential.ts";
import type { HumanActor } from "../../domain/model/HumanAuth.ts";
import type { AccessCredentialRepository, NewCredentialSecret } from "../../domain/repository/AccessCredentialRepository.ts";
import { parseIssueCredentialInput, parseRotateCredentialInput } from "../../shared/credentialSchema.ts";
import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import { UnauthenticatedError } from "../error/UnauthenticatedError.ts";
import type { HumanProjectAuthorizationService } from "../service/HumanProjectAuthorizationService.ts";
import type { AgentCredentialCaller, RuntimeCredentialCaller } from "../service/RuntimeAuthorizationService.ts";
import { generateSecretToken, hashSecretToken, secretEquals } from "../service/secretToken.ts";

const dayMilliseconds = 24 * 60 * 60 * 1000;
const hourMilliseconds = 60 * 60 * 1000;

/**
 * Bearerの形式: `cmp_<kind>.<credentialId>.<secret>`。secretは256bitの乱数（base64url）。
 * kindとIDを含めるのは、hashの照合前に対象行と種別を引くため。IDだけではsecretを推測できない。
 */
const tokenPattern = /^cmp_(agent|runtime)\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/;

/** Credential形式のBearerか。trusted-localでも、この形式はAgent名として扱わずCredentialとして検証する。 */
export const looksLikeCredentialToken = (value: string): boolean => value.startsWith("cmp_");

const formatToken = (kind: CredentialKind, id: string, secret: string) => `cmp_${kind}.${id}.${secret}`;

const newSecret = (kind: CredentialKind, createdByHumanUserId: string, now: number, expiresInDays: number) => {
  const id = randomUUID();
  const secret = generateSecretToken();
  const record: NewCredentialSecret = {
    id,
    prefix: `cmp_${kind}.${id.slice(0, 8)}`,
    secretHash: hashSecretToken(secret),
    expiresAt: now + expiresInDays * dayMilliseconds,
    createdAt: now,
    createdByHumanUserId,
  };
  return { record, token: formatToken(kind, id, secret) };
};

/** 発行・rotationの応答。`token`はこの応答だけで返し、以後は再表示しない。 */
export type IssuedCredential = { credential: AccessCredential; token: string };

/** Project Administrator以上がWeb UIから発行する。AgentやRuntime自身は発行できない（MCPに公開しない）。 */
export class IssueAccessCredentialUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly credentialRepository: AccessCredentialRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(actor: HumanActor, projectId: string, input: unknown): Promise<IssuedCredential> {
    await this.authorization.authorize(actor, projectId, "credential.manage");
    const { kind, principalId, scopes, expiresInDays } = parseIssueCredentialInput(input);
    const { record, token } = newSecret(kind, actor.humanUserId, this.clock(), expiresInDays);
    const result = await this.credentialRepository.issue({ ...record, projectId, kind, principalId, scopes });
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "principal_bound_elsewhere") {
      throw new ConflictError(`Principal ${principalId} already has a Role Grant or an Agent Credential in another Project`, {
        conflict: "PRINCIPAL_BOUND_ELSEWHERE",
      });
    }
    return { credential: result.credential, token };
  }
}

/**
 * 同じkind・Principal・scopesの新Credentialを発行し、旧Credentialを`graceHours`後に失効させる（併用期間）。
 * 旧Credentialの期限がそれより早ければ延ばさない。0なら即時に失効する。
 */
export class RotateAccessCredentialUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly credentialRepository: AccessCredentialRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(
    actor: HumanActor,
    projectId: string,
    credentialId: string,
    input: unknown,
  ): Promise<IssuedCredential & { previous: AccessCredential }> {
    await this.authorization.authorize(actor, projectId, "credential.manage");
    const { expiresInDays, graceHours } = parseRotateCredentialInput(input);
    // kindは作成後に変わらないため、新Credentialのprefix・tokenの種別を先に確定する。
    const current = await this.credentialRepository.findInProject(projectId, credentialId);
    if (!current) throw new NotFoundError(`Credential ${credentialId} was not found`);
    const now = this.clock();
    const { record, token } = newSecret(current.kind, actor.humanUserId, now, expiresInDays);
    const result = await this.credentialRepository.rotate(projectId, credentialId, record, now + graceHours * hourMilliseconds);
    if (result.kind === "not_found") throw new NotFoundError(`Credential ${credentialId} was not found`);
    if (result.kind === "project_archived") throw new ProjectArchivedError(projectId);
    if (result.kind === "not_active") {
      throw new ConflictError("A revoked or expired Credential cannot be rotated; issue a new one", {
        conflict: "CREDENTIAL_NOT_ACTIVE",
      });
    }
    return { credential: result.credential, token, previous: result.previous };
  }
}

/** 取消は次の呼出しから反映される（認証は毎回DBを読む）。冪等で、archivedのProjectでも行える。 */
export class RevokeAccessCredentialUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly credentialRepository: AccessCredentialRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(actor: HumanActor, projectId: string, credentialId: string): Promise<AccessCredential> {
    await this.authorization.authorize(actor, projectId, "credential.manage");
    const credential = await this.credentialRepository.revoke(projectId, credentialId, actor.humanUserId, this.clock());
    if (!credential) throw new NotFoundError(`Credential ${credentialId} was not found`);
    return credential;
  }
}

/** 一覧はsecret・hashを含まない。 */
export class ListAccessCredentialsUseCase {
  constructor(
    private readonly authorization: HumanProjectAuthorizationService,
    private readonly credentialRepository: AccessCredentialRepository,
  ) {}

  async execute(actor: HumanActor, projectId: string): Promise<AccessCredential[]> {
    await this.authorization.authorize(actor, projectId, "credential.manage");
    return this.credentialRepository.listByProject(projectId);
  }
}

/**
 * BearerのCredentialを検証し、呼出し主体へ解決する。形式不正・未知ID・種別違い・改ざん・期限切れ・取消済みは
 * 理由を区別せずUNAUTHENTICATED（どれに当たったかを呼出し側へ漏らさない）。tokenはエラーに含めない。
 */
export class AuthenticateAccessCredentialUseCase {
  constructor(
    private readonly credentialRepository: AccessCredentialRepository,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(token: string): Promise<AgentCredentialCaller | RuntimeCredentialCaller> {
    const invalid = () => new UnauthenticatedError("The Credential is invalid, expired or revoked");
    const match = tokenPattern.exec(token);
    if (!match) throw invalid();
    const [, kind, id, secret] = match;
    const credential = await this.credentialRepository.findForAuthentication(id);
    // hashの照合は、行が無い場合も同じ処理量にする。
    const matches = secretEquals(hashSecretToken(secret), credential?.secretHash ?? "");
    const now = this.clock();
    if (!credential || !matches || credential.kind !== kind || credential.revokedAt !== null || credential.expiresAt <= now) {
      throw invalid();
    }
    await this.credentialRepository.recordUse(credential.id, now);
    const base = { credentialId: credential.id, projectId: credential.projectId, principalId: credential.principalId };
    return credential.kind === "agent" ? { kind: "agent", ...base } : { kind: "runtime", ...base, scopes: credential.scopes };
  }
}
