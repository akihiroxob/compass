import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1WorkspaceInvitationRepository } from "../src/infrastructure/repository/d1/D1WorkspaceInvitationRepository.ts";

test("D1 invitations enforce one pending invitation and atomically replace expired records", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    await database.insertInto("human_user").values({ id: "human", display_name: "Human", email: "human@example.test",
      platform_role: "owner", status: "active", created_at: 1, updated_at: 1 }).execute();
    const { workspaceRepository } = createD1OrganizationInfrastructure(database, binding, activityActorContext);
    const workspace = await workspaceRepository.create({ name: "Workspace", mission: "Goal", vision: null, principles: [], constraints: [] });
    let now = 100;
    const repository = new D1WorkspaceInvitationRepository(asAccessDatabase(database), binding, () => now);
    const command = { workspaceId: workspace.id, email: "new@example.test", role: "editor" as const,
      tokenHash: "first", expiresAt: 200, createdByHumanUserId: "human" };
    const issued = await Promise.all([repository.createInvitation(command), repository.createInvitation({ ...command, tokenHash: "second" })]);
    assert.deepEqual(issued.map(({ kind }) => kind).sort(), ["created", "pending_exists"]);
    const first = issued.find((result) => result.kind === "created");
    assert.ok(first?.kind === "created");
    assert.equal("tokenHash" in first.invitation, false);
    now = 200;
    const oldHash = (await database.selectFrom("workspace_invitation").select("token_hash").executeTakeFirstOrThrow()).token_hash;
    await assert.rejects(repository.createInvitation({ ...command, tokenHash: oldHash, expiresAt: 400 }));
    assert.equal((await repository.listInvitations(workspace.id))[0]?.status, "pending");
    const replacement = await repository.createInvitation({ ...command, tokenHash: "replacement", expiresAt: 400 });
    assert.ok(replacement.kind === "created");
    assert.equal((await repository.listInvitations(workspace.id)).find(({ id }) => id === first.invitation.id)?.status, "revoked");
    const cancellations = await Promise.all([
      repository.revokeInvitation(workspace.id, replacement.invitation.id, "human"),
      repository.revokeInvitation(workspace.id, replacement.invitation.id, "human"),
    ]);
    assert.deepEqual(cancellations.map(({ kind }) => kind).sort(), ["not_pending", "revoked"]);
    await workspaceRepository.archive(workspace.id, "done");
    assert.deepEqual(await repository.createInvitation({ ...command, tokenHash: "archived" }), { kind: "workspace_archived" });
    assert.deepEqual(await repository.revokeInvitation(workspace.id, first.invitation.id, "human"), { kind: "workspace_archived" });
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
