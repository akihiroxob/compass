import type { D1Database } from "@cloudflare/workers-types";
import { sql, CompiledQuery, type Kysely } from "kysely";
import {
  decideRegistration, normalizeEmail, sessionAbsoluteTtlMs,
  SQLiteHumanAccountRepository, toHumanUser, toHumanIdentity, toWebSession,
  type AccessDatabase, type HumanAccountRepository, type RegisterOrLoginCommand, type RegisterOrLoginResult,
  type SessionRevokeReason, type HumanUserTable, type HumanIdentityTable, type WebSessionTable,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { accessWorkspaceReaders } from "../accessReaders.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

/** 登録判定の入力をbatch内で再照合し、認証・招待・Membership・Sessionを一括保存する。 */
export class D1HumanAccountRepository implements HumanAccountRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: Pick<HumanAccountRepository, "resolveSession" | "findHumanById" | "platformOwnerExists">;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database, private readonly clock: () => number = Date.now) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteHumanAccountRepository(database, accessWorkspaceReaders, clock);
  }

  async registerOrLogin(command: RegisterOrLoginCommand): Promise<RegisterOrLoginResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.snapshot(command);
      const decision = decideRegistration(snapshot.facts);
      if (decision.kind === "reject") return { kind: "rejected", reason: decision.reason };
      const { now, existing, invitation } = snapshot;
      const email = normalizeEmail(command.identity.email);
      const displayName = command.identity.displayName?.trim() || email.split("@")[0] || email;
      const humanId = decision.kind === "login" ? decision.humanUserId : crypto.randomUUID();
      const identityId = decision.kind === "login" ? existing!.identity_id : crypto.randomUUID();
      const invitationOutcome = decision.kind === "login" ? decision.invitation : decision.kind === "register_invited" ? "accept" : "none";
      const mutations: CompiledQuery[] = [];
      if (decision.kind === "login") {
        mutations.push(this.database.updateTable("human_user").set({ display_name: displayName, email, updated_at: now }).where("id", "=", humanId).compile(),
          this.database.updateTable("human_identity").set({ email_at_login: email, last_login_at: now }).where("id", "=", identityId).compile());
      } else {
        mutations.push(this.database.insertInto("human_user").values({ id: humanId, display_name: displayName, email,
          platform_role: decision.kind === "bootstrap" ? "owner" : "member", status: "active", created_at: now, updated_at: now }).compile(),
          this.database.insertInto("human_identity").values({ id: identityId, human_user_id: humanId, provider: command.identity.provider,
            issuer: command.identity.issuer, subject: command.identity.subject, email_at_login: email, created_at: now, last_login_at: now }).compile());
      }
      if (invitationOutcome === "accept") {
        mutations.push(this.database.updateTable("workspace_invitation")
          .set({ status: "accepted", accepted_by_human_user_id: humanId, accepted_at: now }).where("id", "=", invitation!.id).compile(),
          this.database.insertInto("workspace_membership").values({ id: crypto.randomUUID(), workspace_id: invitation!.workspace_id,
            human_user_id: humanId, role: invitation!.role, created_at: now, updated_at: now,
            created_by_human_user_id: invitation!.created_by_human_user_id, revoked_at: null, revoked_by_human_user_id: null }).compile());
      }
      const adoptedIndexes: number[] = [];
      if (decision.kind === "bootstrap" || existing?.platform_role === "owner") {
        const workspaceIds = await accessWorkspaceReaders(this.database).listIdsInCreationOrder();
        for (const workspaceId of workspaceIds) {
          const activeMember = this.database.selectFrom("workspace_membership").select("id").where("workspace_id", "=", workspaceId)
            .where("human_user_id", "=", humanId).where("revoked_at", "is", null);
          const owner = this.database.selectFrom("workspace_membership").select("id").where("workspace_id", "=", workspaceId)
            .where("role", "=", "owner").where("revoked_at", "is", null);
          adoptedIndexes.push(mutations.length, mutations.length + 1);
          mutations.push(this.database.updateTable("workspace_membership").set({ role: "owner", updated_at: now })
            .where("workspace_id", "=", workspaceId).where("human_user_id", "=", humanId).where("revoked_at", "is", null)
            .where(sql<boolean>`NOT EXISTS ${owner}`).returning("workspace_id").compile(),
            sql`INSERT INTO workspace_membership (id, workspace_id, human_user_id, role, created_at, updated_at, created_by_human_user_id, revoked_at, revoked_by_human_user_id)
              SELECT ${crypto.randomUUID()}, ${workspaceId}, ${humanId}, 'owner', ${now}, ${now}, NULL, NULL, NULL
              WHERE NOT EXISTS ${owner} AND NOT EXISTS ${activeMember} RETURNING workspace_id`.compile(this.database));
        }
      }
      if (command.previousSessionTokenHash !== null) {
        mutations.push(this.database.updateTable("web_session").set({ revoked_at: now, revoke_reason: "superseded" })
          .where("token_hash", "=", command.previousSessionTokenHash).where("revoked_at", "is", null).compile());
      }
      const sessionIndex = mutations.length;
      mutations.push(this.database.insertInto("web_session").values({ id: crypto.randomUUID(), token_hash: command.sessionTokenHash,
        human_user_id: humanId, created_at: now, last_seen_at: now, expires_at: now + sessionAbsoluteTtlMs,
        revoked_at: null, revoke_reason: null }).returningAll().compile(),
        this.database.selectFrom("human_user").selectAll().where("id", "=", humanId).compile(),
        this.database.selectFrom("human_identity").selectAll().where("id", "=", identityId).compile());
      try {
        const results = await this.atomic.execute(snapshot.guards, mutations);
        const adoptedWorkspaceIds = adoptedIndexes.flatMap((index) => results[index]!.results.map((row) => (row as { workspace_id: string }).workspace_id));
        return { kind: "logged_in", human: toHumanUser(results[sessionIndex + 1]!.results[0] as HumanUserTable),
          identity: toHumanIdentity(results[sessionIndex + 2]!.results[0] as HumanIdentityTable), session: toWebSession(results[sessionIndex]!.results[0] as WebSessionTable),
          created: decision.kind !== "login", bootstrapped: decision.kind === "bootstrap", invitation: invitationOutcome, adoptedWorkspaceIds };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Registration facts changed repeatedly during login");
  }

  resolveSession(tokenHash: string) { return this.reader.resolveSession(tokenHash); }
  findHumanById(id: string) { return this.reader.findHumanById(id); }
  platformOwnerExists() { return this.reader.platformOwnerExists(); }

  async revokeSession(tokenHash: string, reason: SessionRevokeReason): Promise<boolean> {
    const result = await this.database.updateTable("web_session").set({ revoked_at: this.clock(), revoke_reason: reason })
      .where("token_hash", "=", tokenHash).where("revoked_at", "is", null).executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  private async snapshot(command: RegisterOrLoginCommand) {
    const now = this.clock();
    const identityQuery = this.database.selectFrom("human_identity").innerJoin("human_user", "human_user.id", "human_identity.human_user_id")
      .where("human_identity.provider", "=", command.identity.provider).where("human_identity.issuer", "=", command.identity.issuer)
      .where("human_identity.subject", "=", command.identity.subject);
    const existing = await identityQuery.selectAll("human_user").select("human_identity.id as identity_id").executeTakeFirst();
    const ownerQuery = this.database.selectFrom("human_user").select("id").where("platform_role", "=", "owner");
    const ownerExists = await ownerQuery.executeTakeFirst() !== undefined;
    const invitationQuery = command.invitationTokenHash === null ? null
      : this.database.selectFrom("workspace_invitation").selectAll().where("token_hash", "=", command.invitationTokenHash);
    const invitation = await invitationQuery?.executeTakeFirst();
    const membershipQuery = existing && invitation
      ? this.database.selectFrom("workspace_membership").select("id").where("workspace_id", "=", invitation.workspace_id)
        .where("human_user_id", "=", existing.id).where("revoked_at", "is", null) : null;
    const member = await membershipQuery?.executeTakeFirst();
    const workspaceArchived = invitation ? await accessWorkspaceReaders(this.database).isArchived(invitation.workspace_id) : false;
    const guards: CompiledQuery[] = [existing
      ? identityQuery.select("human_identity.id").where("human_identity.id", "=", existing.identity_id)
        .where("human_user.status", "=", existing.status).where("human_user.platform_role", "=", existing.platform_role).compile()
      : this.presence(identityQuery.select("human_identity.id").compile(), false), this.presence(ownerQuery.compile(), ownerExists)];
    if (invitationQuery) {
      guards.push(invitation ? invitationQuery.where("id", "=", invitation.id).where("status", "=", invitation.status)
        .where("expires_at", "=", invitation.expires_at).where("email", "=", invitation.email).where("role", "=", invitation.role)
        .where("workspace_id", "=", invitation.workspace_id).where("created_by_human_user_id", "=", invitation.created_by_human_user_id).compile()
        : this.presence(invitationQuery.compile(), false));
    }
    if (membershipQuery) guards.push(this.presence(membershipQuery.compile(), member !== undefined));
    if (invitation) {
      // Workspaceの状態はOrganizationの公開Readerから取得し、同じ条件をbatch内でも検査する。
      const archiveQuery = sql`SELECT id FROM workspace WHERE id = ${invitation.workspace_id} AND status = 'archived'`;
      guards.push(this.presence(archiveQuery.compile(this.database), workspaceArchived));
    }
    return { now, existing, invitation, guards, facts: {
      identity: command.identity, existingHuman: existing ? { id: existing.id, status: existing.status } : null,
      platformOwnerExists: ownerExists, initialOwnerEmail: command.initialOwnerEmail,
      invitation: command.invitationTokenHash === null ? null : invitation ? {
        found: true as const, status: invitation.status, expiresAt: invitation.expires_at, email: invitation.email,
        alreadyMember: member !== undefined, workspaceArchived,
      } : { found: false as const }, now,
    } };
  }

  private presence(query: CompiledQuery, exists: boolean): CompiledQuery {
    const predicate = exists ? "EXISTS" : "NOT EXISTS";
    return CompiledQuery.raw(`SELECT 1 WHERE ${predicate} (${query.sql})`, [...query.parameters]);
  }
}
