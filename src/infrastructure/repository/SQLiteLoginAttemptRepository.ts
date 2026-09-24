import type { Kysely } from "kysely";
import type { IdentityProvider } from "../../domain/model/HumanAuth.ts";
import type {
  ConsumedLoginAttempt,
  LoginAttemptRepository,
  NewLoginAttempt,
} from "../../domain/repository/LoginAttemptRepository.ts";
import type { Database } from "../database/schema.ts";

export class SQLiteLoginAttemptRepository implements LoginAttemptRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async create(attempt: NewLoginAttempt): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      await transaction.deleteFrom("auth_login_attempt").where("expires_at", "<=", attempt.createdAt).execute();
      await transaction
        .insertInto("auth_login_attempt")
        .values({
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
        })
        .execute();
    });
  }

  async consume(id: string, provider: IdentityProvider, now: number): Promise<ConsumedLoginAttempt | null> {
    return this.database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("auth_login_attempt")
        .selectAll()
        .where("id", "=", id)
        .where("provider", "=", provider)
        .where("consumed_at", "is", null)
        .where("expires_at", ">", now)
        .executeTakeFirst();
      if (!row || row.state === null || row.nonce === null || row.code_verifier === null) return null;
      const updated = await transaction
        .updateTable("auth_login_attempt")
        .set({ consumed_at: now, state: null, nonce: null, code_verifier: null })
        .where("id", "=", id)
        .where("consumed_at", "is", null)
        .executeTakeFirst();
      if (updated.numUpdatedRows === 0n) return null;
      return {
        state: row.state,
        nonce: row.nonce,
        codeVerifier: row.code_verifier,
        returnTo: row.return_to,
        invitationTokenHash: row.invitation_token_hash,
      };
    });
  }
}
