import type {
  ExistingHumanInvitationOutcome,
  HumanIdentity,
  HumanUser,
  RegistrationRejectReason,
  SessionRevokeReason,
  VerifiedIdentity,
  WebSession,
} from "../model/HumanAuth.ts";

export type RegisterOrLoginCommand = {
  identity: VerifiedIdentity;
  /** 設定された初期owner email。platform owner作成後は読まない。 */
  initialOwnerEmail: string | null;
  /** 招待リンク経由のときだけ。招待tokenのSHA-256。 */
  invitationTokenHash: string | null;
  /** 新しいSessionのsecretのSHA-256。平文は渡さない。 */
  sessionTokenHash: string;
  /** 同じブラウザの旧Session（`superseded`で失効させる）。 */
  previousSessionTokenHash: string | null;
};

export type RegisterOrLoginResult =
  | { kind: "rejected"; reason: RegistrationRejectReason }
  | {
      kind: "logged_in";
      human: HumanUser;
      identity: HumanIdentity;
      session: WebSession;
      /** 新規作成したHumanか（bootstrap・招待による登録）。 */
      created: boolean;
      bootstrapped: boolean;
      /** 招待の扱い。新規登録で受諾した場合は`accept`。 */
      invitation: ExistingHumanInvitationOutcome;
      /** このログインでowner Membershipを補完したorphan ProjectのID。 */
      adoptedProjectIds: string[];
    };

export interface HumanAccountRepository {
  /**
   * closed registrationの判定（`decideRegistration`）とその結果の書込を1 transactionで行う。
   * 拒否時は何も書かない。成功時はHuman / Identity / Membership / 招待受諾 / orphan補完 / Session発行を同時に保存する。
   */
  registerOrLogin(command: RegisterOrLoginCommand): Promise<RegisterOrLoginResult>;
  /**
   * 有効なSessionとHumanを返す。無効（未知・取消・期限切れ・アイドル超過・Human無効）はnull。
   * 有効なら`last_seen_at`が更新間隔以上古い場合だけ更新する。
   */
  resolveSession(tokenHash: string): Promise<{ session: WebSession; human: HumanUser } | null>;
  /** 未取消のSessionだけを取消す。未知・取消済みはfalse（冪等）。 */
  revokeSession(tokenHash: string, reason: SessionRevokeReason): Promise<boolean>;
  findHumanById(humanUserId: string): Promise<HumanUser | null>;
  platformOwnerExists(): Promise<boolean>;
}
