import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { AccessDatabase, IdentityProvider, LoginAttemptRepository, NewLoginAttempt } from "@compass/access";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

export class D1LoginAttemptRepository implements LoginAttemptRepository {
  private readonly atomic: D1AtomicBatch;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async create(attempt: NewLoginAttempt): Promise<void> {
    await this.atomic.execute([], [
      this.database.deleteFrom("auth_login_attempt").where("expires_at", "<=", attempt.createdAt).compile(),
      this.database.insertInto("auth_login_attempt").values({
        id: attempt.id,
        provider: attempt.provider,
        state: attempt.state,
        nonce: attempt.nonce,
        code_verifier: attempt.codeVerifier,
        return_to: attempt.returnTo,
        invitation_token_hash: attempt.invitationTokenHash,
        created_at: attempt.createdAt,
        expires_at: attempt.expiresAt,
        consumed_at: null,
      }).compile(),
    ]);
  }

  async consume(id: string, provider: IdentityProvider, now: number) {
    const eligible = this.database.selectFrom("auth_login_attempt")
      .where("id", "=", id).where("provider", "=", provider)
      .where("consumed_at", "is", null).where("expires_at", ">", now);
    const row = await eligible.selectAll().executeTakeFirst();
    if (!row || row.state === null || row.nonce === null || row.code_verifier === null) return null;

    const snapshot = eligible.select("id")
      .where("created_at", "=", row.created_at).where("expires_at", "=", row.expires_at)
      .where("state", "=", row.state).where("nonce", "=", row.nonce)
      .where("code_verifier", "=", row.code_verifier).where("return_to", "is", row.return_to)
      .where("invitation_token_hash", "is", row.invitation_token_hash);
    try {
      await this.atomic.execute([snapshot.compile()], [
        this.database.updateTable("auth_login_attempt")
          .set({ consumed_at: now, state: null, nonce: null, code_verifier: null })
          .where("id", "=", id).compile(),
      ]);
    } catch (error) {
      if (error instanceof D1PreconditionFailedError) return null;
      throw error;
    }
    return { state: row.state, nonce: row.nonce, codeVerifier: row.code_verifier,
      returnTo: row.return_to, invitationTokenHash: row.invitation_token_hash };
  }
}
