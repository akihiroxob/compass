import type { IdentityProvider, VerifiedIdentity } from "../../domain/model/HumanAuth.ts";

/**
 * Identity Provider（Google OIDC等）の検証をapplication層から隠すport。
 * adapterはserver側でcode交換・ID Token検証を行い、Google固有のclaim・型を`VerifiedIdentity`の外へ出さない。
 */
export interface HumanIdentityProvider {
  readonly provider: IdentityProvider;
  /** 認可endpointのURL。redirect URIはadapterの設定値で固定し、requestのHostから組み立てない。 */
  authorizationUrl(request: { state: string; nonce: string; codeChallenge: string }): string;
  /** code交換とID Token検証。検証できなければ`IdentityVerificationError`。 */
  verifyCallback(input: { code: string; codeVerifier: string; nonce: string }): Promise<VerifiedIdentity>;
}

/** OIDC応答を検証できなかった。messageにtoken・code・secretを含めない。 */
export class IdentityVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IdentityVerificationError";
  }
}
