import type {
  ExistingHumanInvitationOutcome,
  HumanUser,
  RegistrationRejectReason,
  VerifiedIdentity,
  WebSession,
} from "../../domain/model/HumanAuth.ts";
import type { HumanAccountRepository } from "../../domain/repository/HumanAccountRepository.ts";
import { ValidationError } from "../error/ValidationError.ts";
import { generateSecretToken, hashSecretToken } from "../service/secretToken.ts";

export type RegisterOrLoginHumanCommand = {
  /** Identity Provider adapterがserverで検証した結果。未検証の値を渡さない。 */
  identity: VerifiedIdentity;
  /** 招待リンク経由のときだけ。平文tokenは保存しない。 */
  invitationToken?: string | null;
  /** 同じブラウザの旧Session Cookie。ログイン成功時に`superseded`で失効させる（Session fixation対策）。 */
  previousSessionToken?: string | null;
};

export type RegisterOrLoginHumanResult =
  | { kind: "rejected"; reason: RegistrationRejectReason }
  | {
      kind: "logged_in";
      /** Cookieへ設定するsecret。応答で一度だけ返し、DBにはhashだけを保存する。 */
      sessionToken: string;
      session: WebSession;
      human: HumanUser;
      created: boolean;
      bootstrapped: boolean;
      invitation: ExistingHumanInvitationOutcome;
      adoptedProjectIds: string[];
    };

const requireText = (value: unknown, path: string) =>
  typeof value === "string" && value.trim().length > 0 ? [] : [{ path, message: `${path} is required` }];

const optionalHash = (token: string | null | undefined) => (token ? hashSecretToken(token) : null);

/**
 * closed registrationによる登録・ログイン（docs/step-6-human-auth-design.md の判定表 #0〜#4）とSession発行。
 * 拒否時はHuman・Identity・Membership・Sessionを作らない。
 */
export class RegisterOrLoginHumanUseCase {
  constructor(
    private readonly humanAccountRepository: HumanAccountRepository,
    /** 設定された初期owner email。platform owner作成後は判定に使われない。 */
    private readonly initialOwnerEmail: string | null,
  ) {}

  async execute(command: RegisterOrLoginHumanCommand): Promise<RegisterOrLoginHumanResult> {
    const { identity } = command;
    const issues = [
      ...requireText(identity.issuer, "identity.issuer"),
      ...requireText(identity.subject, "identity.subject"),
      ...requireText(identity.email, "identity.email"),
      ...(identity.provider === "google" || identity.provider === "local"
        ? []
        : [{ path: "identity.provider", message: "identity.provider must be google or local" }]),
    ];
    if (issues.length) throw new ValidationError("Verified identity is invalid", issues);

    const sessionToken = generateSecretToken();
    const result = await this.humanAccountRepository.registerOrLogin({
      identity,
      initialOwnerEmail: this.initialOwnerEmail,
      invitationTokenHash: optionalHash(command.invitationToken),
      sessionTokenHash: hashSecretToken(sessionToken),
      previousSessionTokenHash: optionalHash(command.previousSessionToken),
    });
    if (result.kind === "rejected") return result;
    return {
      kind: "logged_in",
      sessionToken,
      session: result.session,
      human: result.human,
      created: result.created,
      bootstrapped: result.bootstrapped,
      invitation: result.invitation,
      adoptedProjectIds: result.adoptedProjectIds,
    };
  }
}

/** Session Cookieの値から有効なSessionとHumanを解決する。無効はすべてnull（理由を区別しない）。 */
export class ResolveHumanSessionUseCase {
  constructor(private readonly humanAccountRepository: HumanAccountRepository) {}

  async execute(sessionToken: string | null | undefined): Promise<{ session: WebSession; human: HumanUser } | null> {
    if (!sessionToken) return null;
    return this.humanAccountRepository.resolveSession(hashSecretToken(sessionToken));
  }
}

/** logout。Sessionが無い・取消済みでも成功扱い（冪等）で、取消したかだけを返す。 */
export class RevokeHumanSessionUseCase {
  constructor(private readonly humanAccountRepository: HumanAccountRepository) {}

  async execute(sessionToken: string | null | undefined): Promise<boolean> {
    if (!sessionToken) return false;
    return this.humanAccountRepository.revokeSession(hashSecretToken(sessionToken), "logout");
  }
}
