import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "kysely";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import type { HumanActor, HumanRole, VerifiedIdentity } from "@compass/access";

const ownerEmail = "owner@example.com";

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, Date.now, { initialOwnerEmail: ownerEmail });
  return { database, services };
};

type Services = Awaited<ReturnType<typeof setup>>["services"];

const google = (subject: string, email: string): VerifiedIdentity => ({
  provider: "google",
  issuer: "https://accounts.google.com",
  subject,
  email,
  emailVerified: true,
  displayName: null,
});

const actorOf = (humanUserId: string): HumanActor => ({ kind: "human", humanUserId });

const login = async (services: Services, identity: VerifiedIdentity, invitationToken?: string) => {
  const result = await services.registerOrLoginHumanUseCase.execute({ identity, invitationToken });
  assert.equal(result.kind, "logged_in", `login rejected: ${JSON.stringify(result)}`);
  if (result.kind !== "logged_in") throw new Error("unreachable");
  return result;
};

const bootstrapOwner = async (services: Services) => {
  const result = await login(services, google("owner-sub", ownerEmail));
  return { ...result, actor: actorOf(result.human.id) };
};

/** ProjectのMemberとして招待・登録する（Workspace Memberの追加対象になる）。 */
const inviteToProject = async (services: Services, owner: HumanActor, projectId: string, email: string, role: HumanRole) => {
  const { token } = await services.createProjectInvitationUseCase.execute(owner, projectId, { email, role });
  const result = await login(services, google(`${email}-sub`, email), token);
  return actorOf(result.human.id);
};

/** Actor付きのProject作成で、作成者がownerのWorkspaceとProjectを用意する。 */
const createOwnedProject = async (services: Services, owner: HumanActor, name = "Alpha") => {
  const project = await services.createProjectUseCase.execute({ name, mission: `${name} mission` }, owner);
  return { project, workspaceId: (await workspaceIdOf(services, owner, project.id))! };
};

const workspaceIdOf = async (services: Services, actor: HumanActor, projectId: string) => {
  const workspaces = await services.human.listWorkspaces.execute(actor);
  const project = await services.getProjectUseCase.execute(projectId);
  return workspaces.find(({ name }) => name === project.name)?.id;
};

const rejectsWith = (code: string, details?: Record<string, string>) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  if (details) assert.deepEqual((error as { details?: Record<string, string> }).details, details);
  return true;
};

const memberOf = async (services: Services, owner: HumanActor, workspaceId: string, humanUserId: string) =>
  (await services.human.listWorkspaceMembers.execute(owner, workspaceId)).find(({ human }) => human.id === humanUserId);

test("Actor付きのProject・Workspace作成は作成者のowner Membershipを同一transactionで作り、失敗時は何も保存しない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);

  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  assert.equal((await services.human.getWorkspace.execute(owner.actor, workspaceId)).myRole, "owner");
  assert.equal((await services.human.getProject.execute(owner.actor, project.id)).myRole, "owner");

  const workspace = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, owner.actor);
  const { workspace: found, myRole } = await services.human.getWorkspace.execute(owner.actor, workspace.id);
  assert.deepEqual([found.name, myRole], ["Beta", "owner"]);
  assert.deepEqual(
    (await services.human.listWorkspaces.execute(owner.actor)).map(({ name }) => name).sort(),
    ["Alpha", "Beta"],
  );

  await sql`create trigger fail_workspace_membership before insert on workspace_membership
    begin select raise(abort, 'simulated failure'); end`.execute(database);
  await assert.rejects(services.createProjectUseCase.execute({ name: "Gamma", mission: "M" }, owner.actor), /simulated failure/);
  await assert.rejects(services.human.createWorkspace.execute({ name: "Delta", mission: "M" }, owner.actor), /simulated failure/);
  const names = (await database.selectFrom("workspace").select("name").orderBy("name").execute()).map(({ name }) => name);
  assert.deepEqual(names, ["Alpha", "Beta"]);
  assert.equal((await database.selectFrom("project").select("id").execute()).length, 1);
  await database.destroy();
});

test("Workspace Membershipの認可は未所属・別Workspace・存在しないWorkspaceを404、Role不足を403にし、権限表どおりに操作できる", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const other = await createOwnedProject(services, owner.actor, "Other");

  const actors: Record<Exclude<HumanRole, "owner">, HumanActor> = {
    administrator: await inviteToProject(services, owner.actor, project.id, "admin@example.com", "viewer"),
    editor: await inviteToProject(services, owner.actor, project.id, "editor@example.com", "viewer"),
    viewer: await inviteToProject(services, owner.actor, project.id, "viewer@example.com", "owner"),
  };
  // Project MemberであってもWorkspaceの権限は持たない（継承しない）。
  for (const actor of Object.values(actors)) {
    await assert.rejects(services.human.getWorkspace.execute(actor, workspaceId), rejectsWith("NOT_FOUND"));
    assert.deepEqual((await services.human.listWorkspaces.execute(actor)).map(({ id }) => id), []);
  }
  for (const [role, actor] of Object.entries(actors)) {
    await services.human.addWorkspaceMember.execute(owner.actor, workspaceId, { humanUserId: actor.humanUserId, role });
  }

  // 閲覧はviewer以上。別Workspace・存在しないWorkspaceは区別せず404。
  assert.equal((await services.human.getWorkspace.execute(actors.viewer, workspaceId)).myRole, "viewer");
  assert.equal((await services.human.listWorkspaceMembers.execute(actors.viewer, workspaceId)).length, 4);
  await assert.rejects(services.human.getWorkspace.execute(actors.viewer, other.workspaceId), rejectsWith("NOT_FOUND"));
  await assert.rejects(services.human.getWorkspace.execute(actors.viewer, "missing"), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.human.updateWorkspace.execute(actors.administrator, other.workspaceId, { vision: "x" }),
    rejectsWith("NOT_FOUND"),
  );

  // Mission等の更新・Project作成はadministrator以上、archive・member管理はowner。
  await assert.rejects(
    services.human.updateWorkspace.execute(actors.editor, workspaceId, { vision: "V" }),
    rejectsWith("FORBIDDEN", { requiredRole: "administrator", workspaceId }),
  );
  await assert.rejects(
    services.human.createWorkspaceProject.execute(actors.editor, workspaceId, { name: "By editor" }),
    rejectsWith("FORBIDDEN"),
  );
  assert.equal((await services.human.updateWorkspace.execute(actors.administrator, workspaceId, { vision: "V" })).vision, "V");
  await assert.rejects(
    services.human.archiveWorkspace.execute(actors.administrator, workspaceId, { reason: "r" }),
    rejectsWith("FORBIDDEN", { requiredRole: "owner", workspaceId }),
  );
  await assert.rejects(
    services.human.addWorkspaceMember.execute(actors.administrator, workspaceId, {
      humanUserId: actors.viewer.humanUserId,
      role: "owner",
    }),
    rejectsWith("FORBIDDEN"),
  );
  // Direction管理（editor以上）の認可。Directionの入口はWorkspace scope化（Story 03）で接続する。
  await services.humanWorkspaceAuthorizationService.authorize(actors.editor, workspaceId, "direction.write");
  await assert.rejects(
    services.humanWorkspaceAuthorizationService.authorize(actors.viewer, workspaceId, "direction.write"),
    rejectsWith("FORBIDDEN"),
  );
  await database.destroy();
});

test("Workspace memberの追加は所属ProjectのMemberに限り、Project Workの権限を自動で与えない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const other = await createOwnedProject(services, owner.actor, "Other");
  const outsider = await inviteToProject(services, owner.actor, other.project.id, "outsider@example.com", "editor");

  // 別WorkspaceのProject Member・存在しないHumanは区別せず404。入力の検証は400。
  for (const humanUserId of [outsider.humanUserId, "missing"]) {
    await assert.rejects(
      services.human.addWorkspaceMember.execute(owner.actor, workspaceId, { humanUserId, role: "viewer" }),
      rejectsWith("NOT_FOUND"),
    );
  }
  await assert.rejects(
    services.human.addWorkspaceMember.execute(owner.actor, workspaceId, { humanUserId: "", role: "guest" }),
    rejectsWith("VALIDATION_ERROR"),
  );

  const member = await inviteToProject(services, owner.actor, project.id, "member@example.com", "viewer");
  const added = await services.human.addWorkspaceMember.execute(owner.actor, workspaceId, {
    humanUserId: member.humanUserId,
    role: "editor",
  });
  assert.deepEqual([added.role, added.createdByHumanUserId], ["editor", owner.actor.humanUserId]);
  await assert.rejects(
    services.human.addWorkspaceMember.execute(owner.actor, workspaceId, { humanUserId: member.humanUserId, role: "viewer" }),
    rejectsWith("CONFLICT", { conflict: "ALREADY_MEMBER" }),
  );
  // Workspaceのeditorになっても、ProjectのRoleはviewerのまま（Project Membershipを変えない）。
  assert.equal((await services.human.getProject.execute(member, project.id)).myRole, "viewer");

  // 既存WorkspaceへのProject作成。作成者はProjectのownerになるが、他のWorkspace memberはProjectへ入れない。
  const created = await services.human.createWorkspaceProject.execute(owner.actor, workspaceId, {
    name: "Second",
    description: "Another execution boundary",
    mission: "ignored",
  });
  assert.equal(created.mission, "Alpha mission");
  assert.equal((await services.human.getProject.execute(owner.actor, created.id)).myRole, "owner");
  await assert.rejects(services.human.getProject.execute(member, created.id), rejectsWith("NOT_FOUND"));
  await assert.rejects(services.human.listExecution.execute(member, created.id), rejectsWith("NOT_FOUND"));
  assert.equal((await services.human.listWorkspaceMembers.execute(owner.actor, workspaceId)).length, 2);
  await assert.rejects(
    services.human.createWorkspaceProject.execute(owner.actor, "missing", { name: "X" }),
    rejectsWith("NOT_FOUND"),
  );
  await database.destroy();
});

test("最後のWorkspace ownerの降格・取消はLAST_OWNERで拒否し、取消したmemberはWorkspaceを参照できない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const ownerMembership = (await memberOf(services, owner.actor, workspaceId, owner.actor.humanUserId))!.membership;

  await assert.rejects(
    services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, ownerMembership.id, { role: "administrator" }),
    rejectsWith("CONFLICT", { conflict: "LAST_OWNER" }),
  );
  await assert.rejects(
    services.human.revokeWorkspaceMember.execute(owner.actor, workspaceId, ownerMembership.id),
    rejectsWith("CONFLICT", { conflict: "LAST_OWNER" }),
  );

  const second = await inviteToProject(services, owner.actor, project.id, "second@example.com", "viewer");
  const secondMembership = await services.human.addWorkspaceMember.execute(owner.actor, workspaceId, {
    humanUserId: second.humanUserId,
    role: "owner",
  });
  // 他に有効なownerがいれば自己降格できる。別Workspace・取消済みのMembership IDは404。
  const demoted = await services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, ownerMembership.id, {
    role: "viewer",
  });
  assert.equal(demoted.role, "viewer");
  const revoked = await services.human.revokeWorkspaceMember.execute(second, workspaceId, ownerMembership.id);
  assert.equal(revoked.revokedByHumanUserId, second.humanUserId);
  await assert.rejects(services.human.getWorkspace.execute(owner.actor, workspaceId), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.human.revokeWorkspaceMember.execute(second, workspaceId, ownerMembership.id),
    rejectsWith("NOT_FOUND"),
  );
  // Workspaceの取消はProject Membershipに影響しない（Projectのowner・last-owner保護はそのまま）。
  assert.equal((await services.human.getProject.execute(owner.actor, project.id)).myRole, "owner");
  assert.equal(secondMembership.role, "owner");
  await database.destroy();
});

test("archivedのWorkspaceは参照できるが、Membershipの変更とProject作成を拒否し何も書き込まない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const member = await inviteToProject(services, owner.actor, project.id, "member@example.com", "viewer");
  const membership = await services.human.addWorkspaceMember.execute(owner.actor, workspaceId, {
    humanUserId: member.humanUserId,
    role: "viewer",
  });
  const another = await inviteToProject(services, owner.actor, project.id, "another@example.com", "viewer");
  await services.human.archiveWorkspace.execute(owner.actor, workspaceId, { reason: "Done" });
  const before = await database.selectFrom("workspace_membership").selectAll().orderBy("id").execute();

  const archived = rejectsWith("CONFLICT", { workspaceStatus: "archived" });
  await assert.rejects(
    services.human.addWorkspaceMember.execute(owner.actor, workspaceId, { humanUserId: another.humanUserId, role: "viewer" }),
    archived,
  );
  await assert.rejects(
    services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, membership.id, { role: "editor" }),
    archived,
  );
  await assert.rejects(services.human.revokeWorkspaceMember.execute(owner.actor, workspaceId, membership.id), archived);
  await assert.rejects(services.human.createWorkspaceProject.execute(owner.actor, workspaceId, { name: "Late" }), archived);
  assert.deepEqual(await database.selectFrom("workspace_membership").selectAll().orderBy("id").execute(), before);
  assert.equal((await database.selectFrom("project").select("id").execute()).length, 1);

  assert.equal((await services.human.getWorkspace.execute(member, workspaceId)).workspace.status, "archived");
  assert.deepEqual((await services.human.listWorkspaces.execute(member)).map(({ id }) => id), []);
  assert.deepEqual((await services.human.listWorkspaces.execute(member, "archived")).map(({ id }) => id), [workspaceId]);
  await database.destroy();
});

test("owner不在のWorkspaceはplatform ownerのログインでProjectと同じく補完し、補完は冪等", async () => {
  const { database, services } = await setup();
  // Actorなし（MCP・CLI）で作られたProjectとWorkspaceはowner不在。
  const project = await services.createProjectUseCase.execute({ name: "Orphan", mission: "M" });
  const workspace = await services.human.createWorkspace.execute({ name: "Empty", mission: "M" });

  const owner = await bootstrapOwner(services);
  assert.deepEqual(owner.adoptedProjectIds, [project.id]);
  assert.equal(owner.adoptedWorkspaceIds.length, 2);
  assert.ok(owner.adoptedWorkspaceIds.includes(workspace.id));
  for (const workspaceId of owner.adoptedWorkspaceIds) {
    const membership = await services.humanWorkspaceAuthorizationService.requireWorkspaceRole(owner.actor, workspaceId, "owner");
    assert.equal(membership.createdByHumanUserId, null);
  }

  const again = await login(services, google("owner-sub", ownerEmail));
  assert.deepEqual(again.adoptedWorkspaceIds, []);
  assert.equal((await database.selectFrom("workspace_membership").select("id").execute()).length, 2);
  await database.destroy();
});
