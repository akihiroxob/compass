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

/** Projectの所属Workspaceへ招待・登録し、配下の全Projectに同じRoleを適用する。 */
const inviteToProject = async (services: Services, owner: HumanActor, projectId: string, email: string, role: HumanRole) => {
  const { workspaceId } = await services.getProjectUseCase.execute(projectId);
  const { token } = await services.createWorkspaceInvitationUseCase.execute(owner, workspaceId, { email, role });
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

test("Workspace MembershipのRole水準を配下の既存・新規Projectの参照・編集・管理に同じく適用し、別Workspaceは404にする", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const other = await createOwnedProject(services, owner.actor, "Other");
  const sibling = await services.human.createWorkspaceProject.execute(owner.actor, workspaceId, { name: "Sibling" });

  const actors: Record<HumanRole, HumanActor> = {
    owner: owner.actor,
    administrator: await inviteToProject(services, owner.actor, project.id, "admin@example.com", "administrator"),
    editor: await inviteToProject(services, owner.actor, sibling.id, "editor@example.com", "editor"),
    viewer: await inviteToProject(services, owner.actor, project.id, "viewer@example.com", "viewer"),
  };
  // 招待後に作ったProjectにも、追加操作なしで同じRoleが適用される。
  const created = await services.human.createWorkspaceProject.execute(actors.administrator, workspaceId, {
    name: "Created later",
    mission: "ignored",
  });
  assert.equal(created.mission, "Alpha mission");
  assert.equal((await services.human.listWorkspaceMembers.execute(actors.viewer, workspaceId)).length, 4);

  const authorization = services.humanProjectAuthorizationService;
  const allowed = async (actor: HumanActor, projectId: string, operation: Parameters<typeof authorization.authorize>[2]) =>
    authorization.authorize(actor, projectId, operation).then(() => true, (error: { code?: string }) => {
      assert.equal(error.code, "FORBIDDEN");
      return false;
    });
  // 参照はviewer、Work・Directionの編集はeditor、Project編集・Agent設定はadministrator、archive・招待はowner。
  const expected: Record<HumanRole, Record<"project.read" | "execution.plan" | "project.update" | "grant.manage" | "project.archive", boolean>> = {
    owner: { "project.read": true, "execution.plan": true, "project.update": true, "grant.manage": true, "project.archive": true },
    administrator: { "project.read": true, "execution.plan": true, "project.update": true, "grant.manage": true, "project.archive": false },
    editor: { "project.read": true, "execution.plan": true, "project.update": false, "grant.manage": false, "project.archive": false },
    viewer: { "project.read": true, "execution.plan": false, "project.update": false, "grant.manage": false, "project.archive": false },
  };
  for (const [role, actor] of Object.entries(actors) as [HumanRole, HumanActor][]) {
    for (const projectId of [project.id, sibling.id, created.id]) {
      assert.equal((await services.human.getProject.execute(actor, projectId)).myRole, role);
      for (const [operation, result] of Object.entries(expected[role]) as [keyof (typeof expected)[HumanRole], boolean][]) {
        assert.equal(await allowed(actor, projectId, operation), result, `${role} ${operation} ${projectId}`);
      }
    }
    assert.deepEqual(
      (await services.human.listProjects.execute(actor)).map(({ id }) => id).sort(),
      role === "owner" ? [project.id, sibling.id, created.id, other.project.id].sort() : [project.id, sibling.id, created.id].sort(),
    );
  }
  // 実際のuse caseでも同じ水準で拒否・許可する。
  await assert.rejects(
    services.human.createExecutionStory.execute(actors.viewer, created.id, { title: "By viewer" }),
    rejectsWith("FORBIDDEN", { requiredRole: "editor", projectId: created.id }),
  );
  assert.equal((await services.human.createExecutionStory.execute(actors.editor, created.id, { title: "By editor" })).title, "By editor");
  assert.equal((await services.human.updateProject.execute(actors.administrator, sibling.id, { description: "Updated" })).description, "Updated");

  // 別Workspace（Other）のProject・存在しないProjectは、どのRoleでも区別せず404。
  for (const actor of [actors.administrator, actors.editor, actors.viewer]) {
    for (const projectId of [other.project.id, "missing"]) {
      await assert.rejects(services.human.getProject.execute(actor, projectId), rejectsWith("NOT_FOUND"));
      await assert.rejects(services.human.listExecution.execute(actor, projectId), rejectsWith("NOT_FOUND"));
    }
    await assert.rejects(services.human.getWorkspace.execute(actor, other.workspaceId), rejectsWith("NOT_FOUND"));
  }

  // Workspace操作の権限表（Mission等の更新・Project作成はadministrator以上、archive・member管理はowner）。
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
  const viewerMembership = (await memberOf(services, owner.actor, workspaceId, actors.viewer.humanUserId))!.membership;
  await assert.rejects(
    services.human.changeWorkspaceMemberRole.execute(actors.administrator, workspaceId, viewerMembership.id, { role: "owner" }),
    rejectsWith("FORBIDDEN", { requiredRole: "owner", workspaceId }),
  );
  await services.humanWorkspaceAuthorizationService.authorize(actors.editor, workspaceId, "direction.write");
  await assert.rejects(
    services.humanWorkspaceAuthorizationService.authorize(actors.viewer, workspaceId, "direction.write"),
    rejectsWith("FORBIDDEN"),
  );
  await database.destroy();
});

test("WorkspaceでのRole変更・除外は配下の全Projectへの次の操作から反映し、最後のWorkspace ownerの降格・除外はLAST_OWNERで拒否する", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const sibling = await services.human.createWorkspaceProject.execute(owner.actor, workspaceId, { name: "Sibling" });
  const ownerMembership = (await memberOf(services, owner.actor, workspaceId, owner.actor.humanUserId))!.membership;

  await assert.rejects(
    services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, ownerMembership.id, { role: "administrator" }),
    rejectsWith("CONFLICT", { conflict: "LAST_OWNER" }),
  );
  await assert.rejects(
    services.human.revokeWorkspaceMember.execute(owner.actor, workspaceId, ownerMembership.id),
    rejectsWith("CONFLICT", { conflict: "LAST_OWNER" }),
  );

  const editor = await inviteToProject(services, owner.actor, project.id, "editor@example.com", "editor");
  const editorMembership = (await memberOf(services, owner.actor, workspaceId, editor.humanUserId))!.membership;
  await services.human.createExecutionStory.execute(editor, sibling.id, { title: "Before" });
  // 降格すると、どのProjectでも次の操作から新しいRoleで認可する（Project側に古いRoleは残らない）。
  await services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, editorMembership.id, { role: "viewer" });
  for (const projectId of [project.id, sibling.id]) {
    assert.equal((await services.human.getProject.execute(editor, projectId)).myRole, "viewer");
    await assert.rejects(services.human.createExecutionStory.execute(editor, projectId, { title: "After" }), rejectsWith("FORBIDDEN"));
  }
  // 除外すると、配下の全ProjectとWorkspaceを参照できない。
  await services.human.revokeWorkspaceMember.execute(owner.actor, workspaceId, editorMembership.id);
  for (const projectId of [project.id, sibling.id]) {
    await assert.rejects(services.human.getProject.execute(editor, projectId), rejectsWith("NOT_FOUND"));
  }
  assert.deepEqual(await services.human.listProjects.execute(editor), []);

  const second = await inviteToProject(services, owner.actor, project.id, "second@example.com", "owner");
  // 他に有効なownerがいれば自己降格できる。別Workspace・取消済みのMembership IDは404。
  const demoted = await services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, ownerMembership.id, {
    role: "viewer",
  });
  assert.equal(demoted.role, "viewer");
  await assert.rejects(services.human.archiveProject.execute(owner.actor, project.id, { reason: "r" }), rejectsWith("FORBIDDEN"));
  const revoked = await services.human.revokeWorkspaceMember.execute(second, workspaceId, ownerMembership.id);
  assert.equal(revoked.revokedByHumanUserId, second.humanUserId);
  await assert.rejects(services.human.getWorkspace.execute(owner.actor, workspaceId), rejectsWith("NOT_FOUND"));
  await assert.rejects(services.human.getProject.execute(owner.actor, project.id), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.human.revokeWorkspaceMember.execute(second, workspaceId, ownerMembership.id),
    rejectsWith("NOT_FOUND"),
  );
  const secondMembership = (await memberOf(services, second, workspaceId, second.humanUserId))!.membership;
  await assert.rejects(
    services.human.revokeWorkspaceMember.execute(second, workspaceId, secondMembership.id),
    rejectsWith("CONFLICT", { conflict: "LAST_OWNER" }),
  );
  await database.destroy();
});

test("archivedのWorkspaceは参照できるが、Membershipの変更とProject作成を拒否し何も書き込まない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const { project, workspaceId } = await createOwnedProject(services, owner.actor);
  const member = await inviteToProject(services, owner.actor, project.id, "member@example.com", "viewer");
  const membership = (await memberOf(services, owner.actor, workspaceId, member.humanUserId))!.membership;
  await services.human.archiveWorkspace.execute(owner.actor, workspaceId, { reason: "Done" });
  const before = await database.selectFrom("workspace_membership").selectAll().orderBy("id").execute();

  const archived = rejectsWith("CONFLICT", { workspaceStatus: "archived" });
  await assert.rejects(
    services.human.changeWorkspaceMemberRole.execute(owner.actor, workspaceId, membership.id, { role: "editor" }),
    archived,
  );
  await assert.rejects(services.human.revokeWorkspaceMember.execute(owner.actor, workspaceId, membership.id), archived);
  await assert.rejects(services.human.createWorkspaceProject.execute(owner.actor, workspaceId, { name: "Late" }), archived);
  assert.deepEqual(await database.selectFrom("workspace_membership").selectAll().orderBy("id").execute(), before);
  assert.equal((await database.selectFrom("project").select("id").execute()).length, 1);

  assert.equal((await services.human.getWorkspace.execute(member, workspaceId)).workspace.status, "archived");
  assert.equal((await services.human.getProject.execute(member, project.id)).myRole, "viewer");
  assert.deepEqual((await services.human.listWorkspaces.execute(member)).map(({ id }) => id), []);
  assert.deepEqual((await services.human.listWorkspaces.execute(member, "archived")).map(({ id }) => id), [workspaceId]);
  await database.destroy();
});

test("owner不在のWorkspaceはplatform ownerのログインで補完し、配下Projectも同じMembershipで利用でき、補完は冪等", async () => {
  const { database, services } = await setup();
  // Actorなし（MCP・CLI）で作られたProjectとWorkspaceはowner不在。
  const project = await services.createProjectUseCase.execute({ name: "Orphan", mission: "M" });
  const workspace = await services.human.createWorkspace.execute({ name: "Empty", mission: "M" });

  const owner = await bootstrapOwner(services);
  assert.equal(owner.adoptedWorkspaceIds.length, 2);
  assert.ok(owner.adoptedWorkspaceIds.includes(project.workspaceId));
  assert.equal((await services.human.getProject.execute(owner.actor, project.id)).myRole, "owner");
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
