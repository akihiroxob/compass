import type { Kysely, Transaction } from "kysely";
import {
  decideRegistration,
  isSessionValid,
  normalizeEmail,
  sessionAbsoluteTtlMs,
  sessionLastSeenUpdateIntervalMs,
  type HumanUser,
  type RegistrationFacts,
  type SessionRevokeReason,
  type VerifiedIdentity,
  type WebSession,
} from "../../domain/model/HumanAuth.ts";
import type {
  HumanAccountRepository,
  RegisterOrLoginCommand,
  RegisterOrLoginResult,
} from "../../domain/repository/HumanAccountRepository.ts";
import type { Database } from "../database/schema.ts";
import { isProjectArchived } from "./isProjectArchived.ts";
import { toHumanIdentity, toHumanUser, toWebSession } from "./humanAuthRecord.ts";

/** OIDCの`name`が無ければemailのlocal partを表示名にする。 */
const displayNameOf = (identity: VerifiedIdentity, email: string): string =>
  identity.displayName?.trim() || email.split("@")[0] || email;

export class SQLiteHumanAccountRepository implements HumanAccountRepository {
  constructor(
    private readonly database: Kysely<Database>,
    private readonly clock: () => number = Date.now,
  ) {}

  async registerOrLogin(command: RegisterOrLoginCommand): Promise<RegisterOrLoginResult> {
    return this.database.transaction().execute(async (transaction): Promise<RegisterOrLoginResult> => {
      const now = this.clock();
      const { identity } = command;
      const email = normalizeEmail(identity.email);

      const existingIdentity = await transaction
        .selectFrom("human_identity")
        .innerJoin("human_user", "human_user.id", "human_identity.human_user_id")
        .select(["human_identity.id as identityId", "human_user.id as humanUserId", "human_user.status"])
        .where("human_identity.provider", "=", identity.provider)
        .where("human_identity.issuer", "=", identity.issuer)
        .where("human_identity.subject", "=", identity.subject)
        .executeTakeFirst();
      const platformOwner = await transaction
        .selectFrom("human_user")
        .select("id")
        .where("platform_role", "=", "owner")
        .executeTakeFirst();
      const invitation = command.invitationTokenHash
        ? await transaction
            .selectFrom("project_invitation")
            .selectAll()
            .where("token_hash", "=", command.invitationTokenHash)
            .executeTakeFirst()
        : undefined;
      const alreadyMember =
        existingIdentity && invitation
          ? (await this.findActiveMembershipId(transaction, invitation.project_id, existingIdentity.humanUserId)) !== null
          : false;

      // 受諾のMembership書込と同じtransactionで確認し、archiveとの競合でもMembershipを追加しない。
      const projectArchived = invitation ? await isProjectArchived(transaction, invitation.project_id) : false;

      const facts: RegistrationFacts = {
        identity,
        existingHuman: existingIdentity ? { id: existingIdentity.humanUserId, status: existingIdentity.status } : null,
        platformOwnerExists: platformOwner !== undefined,
        initialOwnerEmail: command.initialOwnerEmail,
        invitation:
          command.invitationTokenHash === null
            ? null
            : invitation
              ? {
                  found: true,
                  status: invitation.status,
                  expiresAt: invitation.expires_at,
                  email: invitation.email,
                  alreadyMember,
                  projectArchived,
                }
              : { found: false },
        now,
      };
      const decision = decideRegistration(facts);
      if (decision.kind === "reject") return { kind: "rejected", reason: decision.reason };

      const displayName = displayNameOf(identity, email);
      let humanUserId: string;
      let identityId: string;
      let invitationOutcome = decision.kind === "login" ? decision.invitation : "none";

      if (decision.kind === "login") {
        humanUserId = decision.humanUserId;
        identityId = existingIdentity!.identityId;
        await transaction
          .updateTable("human_user")
          .set({ display_name: displayName, email, updated_at: now })
          .where("id", "=", humanUserId)
          .execute();
        await transaction
          .updateTable("human_identity")
          .set({ email_at_login: email, last_login_at: now })
          .where("id", "=", identityId)
          .execute();
      } else {
        humanUserId = crypto.randomUUID();
        identityId = crypto.randomUUID();
        await transaction
          .insertInto("human_user")
          .values({
            id: humanUserId,
            display_name: displayName,
            email,
            platform_role: decision.kind === "bootstrap" ? "owner" : "member",
            status: "active",
            created_at: now,
            updated_at: now,
          })
          .execute();
        await transaction
          .insertInto("human_identity")
          .values({
            id: identityId,
            human_user_id: humanUserId,
            provider: identity.provider,
            issuer: identity.issuer,
            subject: identity.subject,
            email_at_login: email,
            created_at: now,
            last_login_at: now,
          })
          .execute();
        if (decision.kind === "register_invited") invitationOutcome = "accept";
      }

      if (invitationOutcome === "accept") {
        // 判定と同じtransaction内で条件付き更新し、同じ招待の二重受諾を防ぐ。
        const accepted = await transaction
          .updateTable("project_invitation")
          .set({ status: "accepted", accepted_by_human_user_id: humanUserId, accepted_at: now })
          .where("id", "=", invitation!.id)
          .where("status", "=", "pending")
          .where("expires_at", ">", now)
          .executeTakeFirst();
        if (accepted.numUpdatedRows !== 1n) throw new Error("Invitation was not pending at acceptance");
        await transaction
          .insertInto("project_membership")
          .values({
            id: crypto.randomUUID(),
            project_id: invitation!.project_id,
            human_user_id: humanUserId,
            role: invitation!.role,
            created_at: now,
            updated_at: now,
            created_by_human_user_id: invitation!.created_by_human_user_id,
            revoked_at: null,
            revoked_by_human_user_id: null,
          })
          .execute();
      }

      const human = await transaction
        .selectFrom("human_user")
        .selectAll()
        .where("id", "=", humanUserId)
        .executeTakeFirstOrThrow();
      const adoptedProjectIds =
        human.platform_role === "owner" ? await this.adoptOrphanProjects(transaction, humanUserId, now) : [];

      if (command.previousSessionTokenHash !== null) {
        await this.revokeByHash(transaction, command.previousSessionTokenHash, "superseded", now);
      }
      const session = await transaction
        .insertInto("web_session")
        .values({
          id: crypto.randomUUID(),
          token_hash: command.sessionTokenHash,
          human_user_id: humanUserId,
          created_at: now,
          last_seen_at: now,
          expires_at: now + sessionAbsoluteTtlMs,
          revoked_at: null,
          revoke_reason: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const identityRow = await transaction
        .selectFrom("human_identity")
        .selectAll()
        .where("id", "=", identityId)
        .executeTakeFirstOrThrow();

      return {
        kind: "logged_in",
        human: toHumanUser(human),
        identity: toHumanIdentity(identityRow),
        session: toWebSession(session),
        created: decision.kind !== "login",
        bootstrapped: decision.kind === "bootstrap",
        invitation: invitationOutcome,
        adoptedProjectIds,
      };
    });
  }

  async resolveSession(tokenHash: string): Promise<{ session: WebSession; human: HumanUser } | null> {
    const now = this.clock();
    const row = await this.database
      .selectFrom("web_session")
      .selectAll()
      .where("token_hash", "=", tokenHash)
      .executeTakeFirst();
    if (!row || !isSessionValid(toWebSession(row), now)) return null;
    const human = await this.findHumanById(row.human_user_id);
    if (!human || human.status !== "active") return null;

    if (now - row.last_seen_at < sessionLastSeenUpdateIntervalMs) return { session: toWebSession(row), human };
    // 判定と更新の間に取消されたSessionを延命しないよう、未取消の条件付きで更新する。
    const updated = await this.database
      .updateTable("web_session")
      .set({ last_seen_at: now })
      .where("id", "=", row.id)
      .where("revoked_at", "is", null)
      .returningAll()
      .executeTakeFirst();
    return updated ? { session: toWebSession(updated), human } : null;
  }

  async revokeSession(tokenHash: string, reason: SessionRevokeReason): Promise<boolean> {
    return this.database.transaction().execute((transaction) =>
      this.revokeByHash(transaction, tokenHash, reason, this.clock()),
    );
  }

  async findHumanById(humanUserId: string): Promise<HumanUser | null> {
    const row = await this.database
      .selectFrom("human_user")
      .selectAll()
      .where("id", "=", humanUserId)
      .executeTakeFirst();
    return row ? toHumanUser(row) : null;
  }

  async platformOwnerExists(): Promise<boolean> {
    const row = await this.database
      .selectFrom("human_user")
      .select("id")
      .where("platform_role", "=", "owner")
      .executeTakeFirst();
    return row !== undefined;
  }

  private async revokeByHash(
    transaction: Transaction<Database>,
    tokenHash: string,
    reason: SessionRevokeReason,
    now: number,
  ): Promise<boolean> {
    const result = await transaction
      .updateTable("web_session")
      .set({ revoked_at: now, revoke_reason: reason })
      .where("token_hash", "=", tokenHash)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  private async findActiveMembershipId(
    transaction: Transaction<Database>,
    projectId: string,
    humanUserId: string,
  ): Promise<string | null> {
    const row = await transaction
      .selectFrom("project_membership")
      .select("id")
      .where("project_id", "=", projectId)
      .where("human_user_id", "=", humanUserId)
      .where("revoked_at", "is", null)
      .executeTakeFirst();
    return row?.id ?? null;
  }

  /**
   * 有効なowner Membershipを持たないProject（認証導入前のProject・MCPで作られたProject）へ、platform ownerの
   * owner Membershipを補完する。既に下位Roleの有効なMembershipがあればownerへ引き上げる。冪等。
   */
  private async adoptOrphanProjects(
    transaction: Transaction<Database>,
    humanUserId: string,
    now: number,
  ): Promise<string[]> {
    const orphans = await transaction
      .selectFrom("project")
      .select("id")
      .where(({ not, exists, selectFrom }) =>
        not(
          exists(
            selectFrom("project_membership")
              .select("project_membership.id")
              .whereRef("project_membership.project_id", "=", "project.id")
              .where("project_membership.role", "=", "owner")
              .where("project_membership.revoked_at", "is", null),
          ),
        ),
      )
      .orderBy("created_at")
      .execute();

    for (const { id: projectId } of orphans) {
      const membershipId = await this.findActiveMembershipId(transaction, projectId, humanUserId);
      if (membershipId) {
        await transaction
          .updateTable("project_membership")
          .set({ role: "owner", updated_at: now })
          .where("id", "=", membershipId)
          .execute();
        continue;
      }
      await transaction
        .insertInto("project_membership")
        .values({
          id: crypto.randomUUID(),
          project_id: projectId,
          human_user_id: humanUserId,
          role: "owner",
          created_at: now,
          updated_at: now,
          created_by_human_user_id: null,
          revoked_at: null,
          revoked_by_human_user_id: null,
        })
        .execute();
    }
    return orphans.map(({ id }) => id);
  }
}
