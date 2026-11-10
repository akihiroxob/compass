import assert from "node:assert/strict";
import test from "node:test";
import { D1LoginAttemptRepository } from "../src/infrastructure/repository/d1/D1LoginAttemptRepository.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";

test("D1 consumes an OIDC attempt once and erases its secrets atomically", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const repository = new D1LoginAttemptRepository(asAccessDatabase(database), binding);
    const attempt = {
      id: "attempt", provider: "google" as const, state: "state", nonce: "nonce",
      codeVerifier: "verifier", returnTo: "/", invitationTokenHash: null, createdAt: 100, expiresAt: 200,
    };
    await repository.create({ ...attempt, id: "expired", createdAt: 10, expiresAt: 100 });
    await repository.create(attempt);
    assert.equal(await repository.consume("expired", "google", 100), null);
    assert.equal(await repository.consume(attempt.id, "google", 200), null);

    const results = await Promise.all([
      repository.consume(attempt.id, "google", 150),
      repository.consume(attempt.id, "google", 150),
    ]);
    assert.deepEqual(results.filter((result) => result !== null), [{
      state: "state", nonce: "nonce", codeVerifier: "verifier", returnTo: "/", invitationTokenHash: null,
    }]);
    assert.deepEqual(await database.selectFrom("auth_login_attempt")
      .select(["id", "state", "nonce", "code_verifier", "consumed_at"]).execute(), [{
      id: attempt.id, state: null, nonce: null, code_verifier: null, consumed_at: 150,
    }]);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
