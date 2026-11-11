import assert from "node:assert/strict";
import test from "node:test";
import type { RegisterOrLoginCommand } from "@compass/access";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { D1HumanAccountRepository } from "../src/infrastructure/repository/d1/D1HumanAccountRepository.ts";
import { D1WorkspaceInvitationRepository } from "../src/infrastructure/repository/d1/D1WorkspaceInvitationRepository.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";

const login = (subject: string, email: string, session: string): RegisterOrLoginCommand => ({
  identity: { provider: "google", issuer: "https://accounts.google.com", subject, email, emailVerified: true, displayName: subject },
  initialOwnerEmail: "owner@example.test", invitationTokenHash: null, sessionTokenHash: session, previousSessionTokenHash: null,
});

const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const access = asAccessDatabase(context.database);
    return { ...context, ...createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext),
      accounts: new D1HumanAccountRepository(access, context.binding, () => 100),
      invitations: new D1WorkspaceInvitationRepository(access, context.binding, () => 100) };
  } catch (error) {
    await context.runtime.dispose();
    throw error;
  }
};

test("D1 bootstrap creates one owner under concurrency and adopts ownerless Workspaces atomically", async () => {
  const { runtime, database, accounts, workspaceRepository } = await setup();
  try {
    const workspace = await workspaceRepository.create({ name: "Orphan", mission: "Goal", vision: null, principles: [], constraints: [] });
    const results = await Promise.all([
      accounts.registerOrLogin(login("first", "owner@example.test", "session-a")),
      accounts.registerOrLogin(login("second", "owner@example.test", "session-b")),
    ]);
    assert.equal(results.filter(({ kind }) => kind === "logged_in").length, 1);
    const success = results.find((result) => result.kind === "logged_in");
    assert.ok(success?.kind === "logged_in");
    assert.deepEqual(success.adoptedWorkspaceIds, [workspace.id]);
    assert.equal(success.bootstrapped, true);
    assert.equal((await database.selectFrom("human_user").selectAll().execute()).length, 1);
    const memberships = await database.selectFrom("workspace_membership").selectAll().execute();
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]?.human_user_id, success.human.id);
    assert.equal(memberships[0]?.role, "owner");
    const session = await accounts.resolveSession(results[0]?.kind === "logged_in" ? "session-a" : "session-b");
    assert.equal(session?.human.id, success.human.id);
    const relogin = await accounts.registerOrLogin({ ...login(success.identity.subject, "changed@example.test", "new-session"),
      previousSessionTokenHash: results[0]?.kind === "logged_in" ? "session-a" : "session-b" });
    assert.ok(relogin.kind === "logged_in");
    assert.equal(relogin.created, false);
    assert.deepEqual(relogin.adoptedWorkspaceIds, []);
    assert.equal(relogin.human.id, success.human.id);
    assert.equal(relogin.human.email, "changed@example.test");
    assert.equal(await accounts.revokeSession("new-session", "logout"), true);
    assert.equal(await accounts.revokeSession("new-session", "logout"), false);
    assert.equal(await accounts.resolveSession("new-session"), null);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});

test("D1 invitation registration creates one Human and Membership and rolls back when Session insertion fails", async () => {
  const { runtime, binding, database, accounts, invitations, workspaceRepository } = await setup();
  try {
    const owner = await accounts.registerOrLogin(login("owner", "owner@example.test", "owner-session"));
    assert.ok(owner.kind === "logged_in");
    const workspace = await workspaceRepository.create({ name: "Business", mission: "Goal", vision: null, principles: [], constraints: [] }, owner.human.id);
    const invite = await invitations.createInvitation({ workspaceId: workspace.id, email: "member@example.test", role: "editor",
      tokenHash: "invite-hash", expiresAt: 1000, createdByHumanUserId: owner.human.id });
    assert.ok(invite.kind === "created");
    const command = { ...login("member", "member@example.test", "member-session"), invitationTokenHash: "invite-hash" };
    await binding.prepare("CREATE TRIGGER reject_session BEFORE INSERT ON web_session BEGIN SELECT RAISE(ABORT, 'test session failure'); END;").run();
    await assert.rejects(accounts.registerOrLogin(command), /test session failure/);
    assert.equal((await database.selectFrom("human_user").selectAll().execute()).length, 1);
    assert.equal((await invitations.listInvitations(workspace.id))[0]?.status, "pending");
    await binding.prepare("DROP TRIGGER reject_session").run();
    const results = await Promise.all([accounts.registerOrLogin(command), accounts.registerOrLogin({ ...command,
      identity: { ...command.identity, subject: "other-member" }, sessionTokenHash: "other-session" })]);
    assert.equal(results.filter(({ kind }) => kind === "logged_in").length, 1);
    assert.equal((await database.selectFrom("human_user").selectAll().execute()).length, 2);
    const members = await database.selectFrom("workspace_membership").selectAll().where("workspace_id", "=", workspace.id).execute();
    assert.equal(members.length, 2);
    assert.equal(members.filter(({ role }) => role === "editor").length, 1);
    assert.equal((await invitations.listInvitations(workspace.id))[0]?.status, "accepted");
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
