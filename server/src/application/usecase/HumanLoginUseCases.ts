import {
  loginAttemptTtlMs,
  normalizeEmail,
  normalizeReturnTo,
  type RegistrationRejectReason,
  type VerifiedIdentity,
  type WebSession,
} from "../../domain/model/HumanAuth.ts";
import type { LoginAttemptRepository } from "../../domain/repository/LoginAttemptRepository.ts";
import { IdentityVerificationError, type HumanIdentityProvider } from "../port/HumanIdentityProvider.ts";
import { generateSecretToken, hashSecretToken, pkceChallenge, secretEquals } from "../service/secretToken.ts";
import type { RegisterOrLoginHumanUseCase } from "./HumanSessionUseCases.ts";

/** `/login?error=<code>`へ渡す拒否理由。Project名・招待先email・Human有無は区別しない。 */
export type LoginRejectReason = RegistrationRejectReason | "oidc_failed";

export type HumanLoginResult =
  | { kind: "rejected"; reason: LoginRejectReason }
  | { kind: "logged_in"; sessionToken: string; session: WebSession; returnTo: string };

const toLoginResult = async (
  registerOrLogin: RegisterOrLoginHumanUseCase,
  identity: VerifiedIdentity,
  options: { invitationTokenHash: string | null; previousSessionToken: string | null; returnTo: string },
): Promise<HumanLoginResult> => {
  const result = await registerOrLogin.execute({
    identity,
    invitationTokenHash: options.invitationTokenHash,
    previousSessionToken: options.previousSessionToken,
  });
  if (result.kind === "rejected") return result;
  return { kind: "logged_in", sessionToken: result.sessionToken, session: result.session, returnTo: options.returnTo };
};

const optionalTokenHash = (token: unknown) =>
  typeof token === "string" && token.trim() !== "" ? hashSecretToken(token.trim()) : null;

/** OIDCのログイン開始。state / nonce / PKCEを持つログイン試行を保存し、認可endpointのURLを返す。 */
export class StartOidcLoginUseCase {
  constructor(
    private readonly loginAttemptRepository: LoginAttemptRepository,
    private readonly identityProvider: HumanIdentityProvider,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(input: { returnTo?: unknown; invitationToken?: unknown }) {
    const attemptToken = generateSecretToken();
    const state = generateSecretToken();
    const nonce = generateSecretToken();
    const codeVerifier = generateSecretToken();
    const now = this.clock();
    await this.loginAttemptRepository.create({
      id: hashSecretToken(attemptToken),
      provider: this.identityProvider.provider,
      state,
      nonce,
      codeVerifier,
      returnTo: normalizeReturnTo(input.returnTo),
      invitationTokenHash: optionalTokenHash(input.invitationToken),
      createdAt: now,
      expiresAt: now + loginAttemptTtlMs,
    });
    return {
      /** ログイン試行Cookieへ設定する値。DBにはhashだけを保存する。 */
      attemptToken,
      authorizationUrl: this.identityProvider.authorizationUrl({ state, nonce, codeChallenge: pkceChallenge(codeVerifier) }),
    };
  }
}

/**
 * OIDC callback。ログイン試行を先に使用済みにしてから（成功・失敗とも再利用させない）state照合・code交換・
 * ID Token検証を行い、closed registrationの規則でSessionを発行する。
 */
export class CompleteOidcLoginUseCase {
  constructor(
    private readonly loginAttemptRepository: LoginAttemptRepository,
    private readonly identityProvider: HumanIdentityProvider,
    private readonly registerOrLoginHumanUseCase: RegisterOrLoginHumanUseCase,
    private readonly clock: () => number = Date.now,
  ) {}

  async execute(input: {
    attemptToken: string | null | undefined;
    code: string | null | undefined;
    state: string | null | undefined;
    /** Identity Providerが返した`error`（利用者の取消等）。 */
    providerError: string | null | undefined;
    previousSessionToken: string | null | undefined;
  }): Promise<HumanLoginResult> {
    const failed = { kind: "rejected", reason: "oidc_failed" } as const;
    if (!input.attemptToken) return failed;
    const attempt = await this.loginAttemptRepository.consume(
      hashSecretToken(input.attemptToken),
      this.identityProvider.provider,
      this.clock(),
    );
    if (!attempt || input.providerError || !input.code || !input.state) return failed;
    if (!secretEquals(input.state, attempt.state)) return failed;

    let identity: VerifiedIdentity;
    try {
      identity = await this.identityProvider.verifyCallback({
        code: input.code,
        codeVerifier: attempt.codeVerifier,
        nonce: attempt.nonce,
      });
    } catch (error) {
      if (error instanceof IdentityVerificationError) return failed;
      throw error;
    }
    return toLoginResult(this.registerOrLoginHumanUseCase, identity, {
      invitationTokenHash: attempt.invitationTokenHash,
      previousSessionToken: input.previousSessionToken ?? null,
      returnTo: attempt.returnTo,
    });
  }
}

/** trusted-local専用のログイン。emailだけを`provider = local`のIdentityとして扱い、登録規則はGoogleと同じ。 */
export const localIdentityIssuer = "urn:compass:local";

export class LocalDevLoginUseCase {
  constructor(private readonly registerOrLoginHumanUseCase: RegisterOrLoginHumanUseCase) {}

  async execute(input: {
    email: unknown;
    returnTo?: unknown;
    invitationToken?: unknown;
    previousSessionToken: string | null | undefined;
  }): Promise<HumanLoginResult> {
    const email = typeof input.email === "string" ? normalizeEmail(input.email) : "";
    if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 320) return { kind: "rejected", reason: "not_allowed" };
    return toLoginResult(
      this.registerOrLoginHumanUseCase,
      { provider: "local", issuer: localIdentityIssuer, subject: email, email, emailVerified: true, displayName: null },
      {
        invitationTokenHash: optionalTokenHash(input.invitationToken),
        previousSessionToken: input.previousSessionToken ?? null,
        returnTo: normalizeReturnTo(input.returnTo),
      },
    );
  }
}
