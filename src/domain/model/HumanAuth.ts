/**
 * Human認証・Project Membership・招待（docs/step-6-human-auth-design.md）。
 * Agent / RuntimeのPrincipal・Role Grantとは別の概念で、型・tableとも混在させない。
 */

/** Project内のHuman Role。`owner` > `administrator` > `editor` > `viewer`の順序で、「最低Role」以上を許可する。 */
export const humanRoles = ["owner", "administrator", "editor", "viewer"] as const;

export type HumanRole = (typeof humanRoles)[number];

const roleRank: Record<HumanRole, number> = { owner: 3, administrator: 2, editor: 1, viewer: 0 };

export const hasMinimumRole = (role: HumanRole, minimumRole: HumanRole): boolean =>
  roleRank[role] >= roleRank[minimumRole];

/** Human向けuse caseの呼び出し主体。Agent用の`Principal`（文字列）とは型で区別する。 */
export type HumanActor = { kind: "human"; humanUserId: string };

export type IdentityProvider = "google" | "local";

/**
 * Identity Provider adapterがserverで検証した結果。domain / applicationはGoogle固有のclaimを持たない。
 * 本人識別の正本は`(provider, issuer, subject)`で、emailは表示と招待照合の補助にだけ使う。
 */
export type VerifiedIdentity = {
  provider: IdentityProvider;
  issuer: string;
  subject: string;
  email: string;
  emailVerified: boolean;
  displayName: string | null;
};

export type PlatformRole = "owner" | "member";
export type HumanUserStatus = "active" | "disabled";

export type HumanUser = {
  readonly id: string;
  readonly displayName: string;
  /** 最後に検証されたemail（小文字）。本人識別には使わない。 */
  readonly email: string;
  readonly platformRole: PlatformRole;
  readonly status: HumanUserStatus;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type HumanIdentity = {
  readonly id: string;
  readonly humanUserId: string;
  readonly provider: IdentityProvider;
  readonly issuer: string;
  readonly subject: string;
  readonly emailAtLogin: string;
  readonly createdAt: number;
  readonly lastLoginAt: number;
};

/** Sessionの絶対期限・アイドル期限・`last_seen_at`の更新間隔。値は定数のこの1箇所。 */
export const sessionAbsoluteTtlMs = 7 * 24 * 60 * 60 * 1000;
export const sessionIdleTtlMs = 24 * 60 * 60 * 1000;
export const sessionLastSeenUpdateIntervalMs = 5 * 60 * 1000;

/** OIDCのログイン試行（state / nonce / PKCE）の有効期間。 */
export const loginAttemptTtlMs = 10 * 60 * 1000;

/**
 * ログイン後の遷移先。同一origin内の相対path（`/`で始まり`//`・`\`・制御文字を含まない）だけを許し、
 * それ以外は`/`にする（open redirect対策）。
 */
export const normalizeReturnTo = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 2048) return "/";
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\")) return "/";
  if (/[\u0000-\u001f\u007f]/.test(value)) return "/";
  return value;
};

export type SessionRevokeReason = "logout" | "human_disabled" | "superseded";

/** Cookieの平文secretは持たない。`tokenHash`だけを保存する。 */
export type WebSession = {
  readonly id: string;
  readonly humanUserId: string;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  readonly revokeReason: SessionRevokeReason | null;
};

/** 期限切れは行を更新せず判定で無効にする（Claimと同じ考え方）。 */
export const isSessionValid = (session: WebSession, now: number): boolean =>
  session.revokedAt === null && now < session.expiresAt && now < session.lastSeenAt + sessionIdleTtlMs;

export type ProjectMembership = {
  readonly id: string;
  readonly projectId: string;
  readonly humanUserId: string;
  readonly role: HumanRole;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** 付与したHuman。bootstrap・orphan補完はnull。 */
  readonly createdByHumanUserId: string | null;
  readonly revokedAt: number | null;
  readonly revokedByHumanUserId: string | null;
};

/** 招待の既定期限と指定可能範囲（時間）。 */
export const invitationDefaultTtlHours = 7 * 24;
export const invitationMinTtlHours = 1;
export const invitationMaxTtlHours = 30 * 24;

export type InvitationStatus = "pending" | "accepted" | "revoked";

/** 招待tokenの平文は発行応答で一度だけ返し、ここには含めない。 */
export type ProjectInvitation = {
  readonly id: string;
  readonly projectId: string;
  readonly email: string;
  readonly role: HumanRole;
  /** 保存値。期限切れは状態を書き換えず`expiresAt`で判定する。 */
  readonly status: InvitationStatus;
  readonly expiresAt: number;
  readonly createdByHumanUserId: string;
  readonly createdAt: number;
  readonly acceptedByHumanUserId: string | null;
  readonly acceptedAt: number | null;
  readonly revokedByHumanUserId: string | null;
  readonly revokedAt: number | null;
};

export const isInvitationUsable = (invitation: Pick<ProjectInvitation, "status" | "expiresAt">, now: number) =>
  invitation.status === "pending" && now < invitation.expiresAt;

/** emailはtrim・小文字化だけを行う（Gmailのドット等は正規化しない）。 */
export const normalizeEmail = (email: string): string => email.trim().toLowerCase();

/** 登録判定に必要な事実。Repositoryが書込transactionの中で集める。 */
export type RegistrationFacts = {
  identity: VerifiedIdentity;
  /** `(provider, issuer, subject)`で見つかったHuman。 */
  existingHuman: Pick<HumanUser, "id" | "status"> | null;
  platformOwnerExists: boolean;
  /** 設定された初期owner email。platform owner作成後は判定に使わない。 */
  initialOwnerEmail: string | null;
  /** 招待tokenなしはnull。tokenはあるが該当なしは`{ found: false }`。 */
  invitation:
    | null
    | { found: false }
    | {
        found: true;
        status: InvitationStatus;
        expiresAt: number;
        email: string;
        /** 招待先Projectに、そのHumanが既に有効なMembershipを持つ。新規Humanではfalse。 */
        alreadyMember: boolean;
        /** 招待先Projectがarchived（参照専用）。受諾してMembershipを追加しない。 */
        projectArchived: boolean;
      };
  now: number;
};

export type RegistrationRejectReason = "not_allowed" | "invitation_expired";

/** 既存Humanのログインで招待tokenを渡された場合の扱い。ログイン自体の成否には影響しない。 */
export type ExistingHumanInvitationOutcome = "none" | "accept" | "already_member" | "expired" | "invalid";

export type RegistrationDecision =
  | { kind: "reject"; reason: RegistrationRejectReason }
  | { kind: "login"; humanUserId: string; invitation: ExistingHumanInvitationOutcome }
  | { kind: "bootstrap" }
  | { kind: "register_invited" };

const invitationEmailMatches = (invitationEmail: string, identity: VerifiedIdentity) =>
  normalizeEmail(invitationEmail) === normalizeEmail(identity.email);

/**
 * closed registrationの判定表（#0〜#4）。いずれの拒否でもHuman・Identity・Membership・Sessionを作らない。
 * 拒否理由は`not_allowed`（未許可・email未検証・email不一致・無効/使用済み/取消済み/archived Projectの招待）と
 * `invitation_expired`（期限切れ招待）だけに区別し、Project名やHumanの有無を漏らさない。
 */
export const decideRegistration = (facts: RegistrationFacts): RegistrationDecision => {
  const { identity, invitation, now } = facts;
  if (!identity.emailVerified) return { kind: "reject", reason: "not_allowed" };

  if (facts.existingHuman) {
    if (facts.existingHuman.status !== "active") return { kind: "reject", reason: "not_allowed" };
    const humanUserId = facts.existingHuman.id;
    if (invitation === null) return { kind: "login", humanUserId, invitation: "none" };
    if (
      !invitation.found ||
      invitation.status !== "pending" ||
      invitation.projectArchived ||
      !invitationEmailMatches(invitation.email, identity)
    ) {
      return { kind: "login", humanUserId, invitation: "invalid" };
    }
    if (now >= invitation.expiresAt) return { kind: "login", humanUserId, invitation: "expired" };
    if (invitation.alreadyMember) return { kind: "login", humanUserId, invitation: "already_member" };
    return { kind: "login", humanUserId, invitation: "accept" };
  }

  if (
    !facts.platformOwnerExists &&
    facts.initialOwnerEmail !== null &&
    normalizeEmail(facts.initialOwnerEmail) === normalizeEmail(identity.email)
  ) {
    return { kind: "bootstrap" };
  }

  if (
    invitation?.found &&
    invitation.status === "pending" &&
    !invitation.projectArchived &&
    invitationEmailMatches(invitation.email, identity)
  ) {
    if (now >= invitation.expiresAt) return { kind: "reject", reason: "invitation_expired" };
    return { kind: "register_invited" };
  }
  return { kind: "reject", reason: "not_allowed" };
};

/**
 * Human向けProject操作の権限表（操作 → 最低Role。docs/step-6-human-auth-design.md「権限表（Human Role）」）。
 * Web routeやUIに重複させず、application層の`HumanProjectAuthorizationService`だけがこの表で検査する。
 * Project作成・一覧・Session取得はMembershipを要しない（認証済みであればよい）ため、ここに含めない。
 */
export const humanProjectPermissions = {
  /** Project・Intent・Outcome・Research・Direction Decision・ADR参照・Execution Summary・Evaluation・Execution（Story / Task / Comment / Change Log）の参照。archivedでも参照できる。 */
  "project.read": "viewer",
  "grant.read": "viewer",
  "member.read": "viewer",
  "direction.write": "editor",
  /** Execution Taskへの介入（受入・差戻し・取消・Comment。Task 46）。archivedでは拒否する。 */
  "execution.intervene": "editor",
  "project.update": "administrator",
  "grant.manage": "administrator",
  /** Agent / Runtime Credentialの発行・rotation・取消・一覧（Task 37）。 */
  "credential.manage": "administrator",
  "project.archive": "owner",
  "invitation.manage": "owner",
  "member.manage": "owner",
} as const satisfies Record<string, HumanRole>;

export type HumanProjectOperation = keyof typeof humanProjectPermissions;

/**
 * Human operatorがExecutionへ介入したときのChange Log・Commentの`principalId`。Agent Principalと区別できるよう`human:`を付ける。
 * 外部入力から受け取らず、認証済みの`HumanActor`からだけ導出する。
 */
export const humanOperatorPrincipalId = (actor: HumanActor): string => `human:${actor.humanUserId}`;
