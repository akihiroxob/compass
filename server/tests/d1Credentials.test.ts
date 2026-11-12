import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1AccessCredentialRepository } from "../src/infrastructure/repository/d1/D1AccessCredentialRepository.ts";
import { D1ProjectGrantRepository } from "../src/infrastructure/repository/d1/D1ProjectGrantRepository.ts";
import type { NewCredential, CredentialScope } from "@compass/access";

const secret = (id: string) => ({ id, prefix: id, secretHash: `hash-${id}`, expiresAt: 1000, createdAt: 100, createdByHumanUserId: "human" });
const credential = (id: string, scope: CredentialScope): NewCredential => ({ ...secret(id), scope, kind: "agent", principalId: "agent", scopes: [] });

const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    await context.database.insertInto("human_user").values({ id: "human", display_name: "Human", email: "human@example.test",
      platform_role: "owner", status: "active", created_at: 1, updated_at: 1 }).execute();
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const first = await organization.workspaceRepository.create({ name: "First", mission: "Goal", vision: null, principles: [], constraints: [] });
    const second = await organization.workspaceRepository.create({ name: "Second", mission: "Goal", vision: null, principles: [], constraints: [] });
    const access = asAccessDatabase(context.database);
    return { ...context, ...organization, first, second, credentials: new D1AccessCredentialRepository(access, context.binding),
      grants: new D1ProjectGrantRepository(access, context.binding, () => 100) };
  } catch (error) {
    await context.runtime.dispose();
    throw error;
  }
};

test("D1 concurrent credential issuance binds an Agent Principal to exactly one scope", async () => {
  const { runtime, database, first, second, credentials, grants, projectRepository } = await setup();
  try {
    const scopes = [{ kind: "workspace" as const, id: first.id }, { kind: "workspace" as const, id: second.id }];
    const results = await Promise.all(scopes.map((scope, i) => credentials.issue(credential(`credential-${i}`, scope))));
    assert.deepEqual(results.map(({ kind }) => kind).sort(), ["issued", "principal_bound_elsewhere"]);
    const issued = results.find((result) => result.kind === "issued");
    assert.ok(issued?.kind === "issued");
    assert.equal("secretHash" in issued.credential, false);
    assert.equal((await database.selectFrom("access_credential").selectAll().execute()).length, 1);
    const project = await projectRepository.createInWorkspace(issued.credential.scope.id, { name: "Product", description: null, repositories: [], resources: [] });
    assert.ok(project.kind === "created");
    assert.deepEqual(await grants.grant(project.project.id, "agent", "worker"), { kind: "principal_bound_elsewhere" });
    assert.equal(await credentials.findInScope({ kind: "project", id: project.project.id }, issued.credential.id), null);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 credential rotation preserves scope, shortens expiry atomically, and revoke remains idempotent", async () => {
  const { runtime, binding, database, first, credentials, workspaceRepository } = await setup();
  try {
    const scope = { kind: "workspace" as const, id: first.id };
    assert.equal((await credentials.issue(credential("old", scope))).kind, "issued");
    await binding.prepare("CREATE TRIGGER reject_shortening BEFORE UPDATE OF expires_at ON access_credential BEGIN SELECT RAISE(ABORT, 'forced expiry failure'); END;").run();
    await assert.rejects(credentials.rotate(scope, "old", secret("failed"), 300), /forced expiry failure/);
    assert.equal(await credentials.findInScope(scope, "failed"), null);
    assert.equal((await credentials.findInScope(scope, "old"))?.expiresAt, 1000);
    await binding.prepare("DROP TRIGGER reject_shortening").run();
    const rotated = await credentials.rotate(scope, "old", secret("new"), 300);
    assert.ok(rotated.kind === "rotated");
    assert.equal(rotated.previous.expiresAt, 300);
    assert.equal(rotated.credential.rotatedFromId, "old");
    assert.deepEqual(rotated.credential.scope, scope);
    assert.equal((await credentials.findForAuthentication("new"))?.secretHash, "hash-new");
    await credentials.recordUse("new", 200);
    assert.equal((await credentials.findInScope(scope, "new"))?.lastUsedAt, 200);
    const revoked = await credentials.revoke(scope, "new", "human", 210);
    assert.deepEqual(await credentials.revoke(scope, "new", "human", 220), revoked);
    assert.deepEqual(await credentials.rotate(scope, "new", secret("after-revoke"), 300), { kind: "not_active" });
    await workspaceRepository.archive(first.id, "done");
    assert.deepEqual(await credentials.issue(credential("after-archive", scope)), { kind: "scope_archived" });
    assert.deepEqual(await credentials.rotate(scope, "old", secret("after-archive-rotation"), 300), { kind: "scope_archived" });
    assert.equal((await credentials.revoke(scope, "old", "human", 250))?.revokedAt, 250);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
