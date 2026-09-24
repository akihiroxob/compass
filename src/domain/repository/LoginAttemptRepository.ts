import type { IdentityProvider } from "../model/HumanAuth.ts";

/** OIDCのログイン試行（state / nonce / PKCE）。`id`はログイン試行Cookie値のSHA-256で、平文は保存しない。 */
export type NewLoginAttempt = {
  id: string;
  provider: IdentityProvider;
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
  invitationTokenHash: string | null;
  createdAt: number;
  expiresAt: number;
};

export type ConsumedLoginAttempt = Pick<
  NewLoginAttempt,
  "state" | "nonce" | "codeVerifier" | "returnTo" | "invitationTokenHash"
>;

export interface LoginAttemptRepository {
  /** 期限切れの試行を掃除してから保存する（schedulerを持たない）。 */
  create(attempt: NewLoginAttempt): Promise<void>;
  /**
   * 未使用・期限内の試行を原子的に使用済みにし、照合用の値を返す。state / nonce / code_verifierは同時に消去する。
   * 未知・使用済み・期限切れ・別providerはnull。
   */
  consume(id: string, provider: IdentityProvider, now: number): Promise<ConsumedLoginAttempt | null>;
}
