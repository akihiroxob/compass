import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Kysely } from "kysely";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import type { Database } from "../src/infrastructure/database/schema.ts";
import {
  decideRegistration,
  sessionAbsoluteTtlMs,
  sessionIdleTtlMs,
  type HumanActor,
  type VerifiedIdentity,
} from "../src/domain/model/HumanAuth.ts";

const ownerEmail = "owner@example.com";
const hour = 60 * 60 * 1000;

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const clock = { now: 1_800_000_000_000 };
  const services = createApplicationServices(database, undefined, () => clock.now, { initialOwnerEmail: ownerEmail });
  return { database, services, clock };
};

type Services = Awaited<ReturnType<typeof setup>>["services"];

const google = (subject: string, email: string, overrides: Partial<VerifiedIdentity> = {}): VerifiedIdentity => ({
  provider: "google",
  issuer: "https://accounts.google.com",
  subject,
  email,
  emailVerified: true,
  displayName: null,
  ...overrides,
});

const login = async (services: Services, identity: VerifiedIdentity, options: { invitationToken?: string } = {}) => {
  const result = await services.registerOrLoginHumanUseCase.execute({ identity, ...options });
  assert.equal(result.kind, "logged_in", `login rejected: ${JSON.stringify(result)}`);
  if (result.kind !== "logged_in") throw new Error("unreachable");
  return result;
};

const actorOf = (humanUserId: string): HumanActor => ({ kind: "human", humanUserId });

const bootstrapOwner = async (services: Services) => {
  const result = await login(services, google("owner-sub", ownerEmail));
  return { ...result, actor: actorOf(result.human.id) };
};

const countRows = async (database: Kysely<Database>) => {
  const count = async (table: "human_user" | "human_identity" | "web_session" | "project_membership") =>
    Number((await database.selectFrom(table).select((eb) => eb.fn.countAll<number>().as("n")).executeTakeFirstOrThrow()).n);
  return {
    human_user: await count("human_user"),
    human_identity: await count("human_identity"),
    web_session: await count("web_session"),
    project_membership: await count("project_membership"),
  };
};

const rejectsWith = (code: string, details?: Record<string, string>) => (error: unknown) => {
  assert.equal((error as { code?: string }).code, code);
  if (details) assert.deepEqual((error as { details?: Record<string, string> }).details, details);
  return true;
};

/** 招待を発行し、招待されたHumanをログインさせてMembershipを作る。 */
const invite = async (
  services: Services,
  owner: HumanActor,
  projectId: string,
  email: string,
  role: "owner" | "administrator" | "editor" | "viewer",
) => {
  const { token } = await services.createProjectInvitationUseCase.execute(owner, projectId, { email, role });
  const result = await login(services, google(`${email}-sub`, email), { invitationToken: token });
  const members = await services.listProjectMembersUseCase.execute(owner, projectId);
  const member = members.find(({ human }) => human.id === result.human.id)!;
  return { actor: actorOf(result.human.id), membershipId: member.membership.id, token };
};

test("既存Project・Intent・Outcome・Grantを持つDBへschemaを再適用してもデータを失わず、初期ownerのbootstrapでorphan Projectを補完する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-human-auth-"));
  const path = join(directory, "compass.db");
  try {
    const legacy = await setup(path);
    const project = await legacy.services.createProjectUseCase.execute({ name: "Legacy", mission: "Keep it" });
    const intent = await legacy.services.createIntentUseCase.execute(project.id, {
      title: "Agents improve software",
      desiredState: "Agents improve the software.",
    });
    await legacy.services.grantProjectRoleUseCase.execute(project.id, { principalId: "strat-1", role: "strategist" });
    // 認証導入前のDBを模して、Human関連tableを削除してから再初期化する。
    for (const table of ["project_invitation", "project_membership", "auth_login_attempt", "web_session", "human_identity", "human_user"]) {
      await legacy.database.schema.dropTable(table).execute();
    }
    await legacy.database.destroy();

    const { database, services } = await setup(path);
    await initializeSchema(database);
    assert.equal((await services.getProjectUseCase.execute(project.id)).name, "Legacy");
    assert.deepEqual((await services.listIntentsUseCase.execute(project.id)).map(({ id }) => id), [intent.id]);
    assert.equal((await services.listProjectGrantsUseCase.execute(project.id)).length, 1);
    assert.deepEqual(await countRows(database), { human_user: 0, human_identity: 0, web_session: 0, project_membership: 0 });

    const owner = await bootstrapOwner(services);
    assert.equal(owner.bootstrapped, true);
    assert.equal(owner.human.platformRole, "owner");
    assert.deepEqual(owner.adoptedProjectIds, [project.id]);
    const membership = await services.humanProjectAuthorizationService.requireProjectRole(owner.actor, project.id, "owner");
    assert.equal(membership.createdByHumanUserId, null);

    // 補完は冪等で、2回目のログインでは新たなMembershipを作らない。
    const again = await login(services, google("owner-sub", ownerEmail));
    assert.deepEqual(again.adoptedProjectIds, []);
    assert.equal((await countRows(database)).project_membership, 1);
    await database.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("初期owner以外・email未検証のaccountは拒否し、Human・Identity・Membership・Sessionを作らない", async () => {
  const { database, services } = await setup();
  await services.createProjectUseCase.execute({ name: "Orphan", mission: "m" });

  const stranger = await services.registerOrLoginHumanUseCase.execute({ identity: google("x", "stranger@example.com") });
  assert.deepEqual(stranger, { kind: "rejected", reason: "not_allowed" });
  const unverified = await services.registerOrLoginHumanUseCase.execute({
    identity: google("owner-sub", ownerEmail, { emailVerified: false }),
  });
  assert.deepEqual(unverified, { kind: "rejected", reason: "not_allowed" });
  assert.deepEqual(await countRows(database), { human_user: 0, human_identity: 0, web_session: 0, project_membership: 0 });

  await bootstrapOwner(services);
  // platform owner作成後は初期owner emailと一致しても別Humanをownerにしない。
  const sameEmailOtherSubject = await services.registerOrLoginHumanUseCase.execute({
    identity: google("other-sub", ownerEmail),
  });
  assert.deepEqual(sameEmailOtherSubject, { kind: "rejected", reason: "not_allowed" });
  assert.equal((await countRows(database)).human_user, 1);
  await database.destroy();
});

test("2回目以降はissuer + subjectで同じHumanへ解決し、email変更で別Humanを作らない", async () => {
  const { database, services } = await setup();
  const first = await bootstrapOwner(services);
  const renamed = await login(services, google("owner-sub", "Renamed@Example.com", { displayName: "Owner" }));
  assert.equal(renamed.human.id, first.human.id);
  assert.equal(renamed.created, false);
  assert.equal(renamed.human.email, "renamed@example.com");
  assert.equal(renamed.human.displayName, "Owner");

  // 同じsubjectでもissuer・providerが違えば別Identity（ここでは未許可として拒否）。
  const otherIssuer = await services.registerOrLoginHumanUseCase.execute({
    identity: google("owner-sub", ownerEmail, { issuer: "https://issuer.example.com" }),
  });
  assert.equal(otherIssuer.kind, "rejected");
  assert.equal((await countRows(database)).human_identity, 1);
  await database.destroy();
});

test("Session tokenは平文で保存せず、解決・logout・期限・アイドル超過・再ログインでの失効が機能する", async () => {
  const { database, services, clock } = await setup();
  const owner = await bootstrapOwner(services);
  const rows = await database.selectFrom("web_session").selectAll().execute();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(owner.sessionToken));
  assert.ok(!JSON.stringify(owner.session).includes(owner.sessionToken));

  assert.equal((await services.resolveHumanSessionUseCase.execute(owner.sessionToken))?.human.id, owner.human.id);
  assert.equal(await services.resolveHumanSessionUseCase.execute("unknown-token"), null);
  assert.equal(await services.resolveHumanSessionUseCase.execute(null), null);

  // アイドル期限内のアクセスで`last_seen_at`が進み、絶対期限で無効になる。
  for (let elapsed = 0; elapsed + sessionIdleTtlMs / 2 < sessionAbsoluteTtlMs; elapsed += sessionIdleTtlMs / 2) {
    clock.now += sessionIdleTtlMs / 2;
    if (clock.now >= owner.session.expiresAt) break;
    assert.ok(await services.resolveHumanSessionUseCase.execute(owner.sessionToken));
  }
  clock.now = owner.session.expiresAt;
  assert.equal(await services.resolveHumanSessionUseCase.execute(owner.sessionToken), null);

  const idle = await login(services, google("owner-sub", ownerEmail));
  clock.now += sessionIdleTtlMs;
  assert.equal(await services.resolveHumanSessionUseCase.execute(idle.sessionToken), null);

  const current = await login(services, google("owner-sub", ownerEmail));
  const next = await services.registerOrLoginHumanUseCase.execute({
    identity: google("owner-sub", ownerEmail),
    previousSessionToken: current.sessionToken,
  });
  assert.equal(next.kind, "logged_in");
  assert.equal(await services.resolveHumanSessionUseCase.execute(current.sessionToken), null);
  const superseded = await database.selectFrom("web_session").select("revoke_reason").where("id", "=", current.session.id).executeTakeFirstOrThrow();
  assert.equal(superseded.revoke_reason, "superseded");

  if (next.kind !== "logged_in") throw new Error("unreachable");
  assert.equal(await services.revokeHumanSessionUseCase.execute(next.sessionToken), true);
  assert.equal(await services.revokeHumanSessionUseCase.execute(next.sessionToken), false);
  assert.equal(await services.resolveHumanSessionUseCase.execute(next.sessionToken), null);
  await database.destroy();
});

test("Actor付きのProject作成はowner Membershipを同一transactionで作り、失敗時はProjectも保存しない", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const project = await services.createProjectUseCase.execute({ name: "Owned", mission: "m" }, owner.actor);
  const membership = await services.humanProjectAuthorizationService.requireProjectRole(owner.actor, project.id, "owner");
  assert.equal(membership.createdByHumanUserId, owner.human.id);

  const before = (await services.listProjectsUseCase.execute()).length;
  await assert.rejects(services.createProjectUseCase.execute({ name: "Ghost", mission: "m" }, actorOf("missing-human")));
  assert.equal((await services.listProjectsUseCase.execute()).length, before);
  await database.destroy();
});

test("Membership認可は未所属・別Project・存在しないProjectを404、Role不足を403にする", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const projectP = await services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);
  const projectQ = await services.createProjectUseCase.execute({ name: "Q", mission: "m" }, owner.actor);
  const viewer = await invite(services, owner.actor, projectP.id, "viewer@example.com", "viewer");

  assert.equal((await services.listProjectMembersUseCase.execute(viewer.actor, projectP.id)).length, 2);
  await assert.rejects(services.listProjectMembersUseCase.execute(viewer.actor, projectQ.id), rejectsWith("NOT_FOUND"));
  await assert.rejects(services.listProjectMembersUseCase.execute(viewer.actor, "missing"), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.listProjectInvitationsUseCase.execute(viewer.actor, projectP.id),
    rejectsWith("FORBIDDEN", { requiredRole: "owner", projectId: projectP.id }),
  );
  // administrator以下は自分のRoleも変えられない（自己昇格の防止）。
  await assert.rejects(
    services.changeProjectMemberRoleUseCase.execute(viewer.actor, projectP.id, viewer.membershipId, { role: "owner" }),
    rejectsWith("FORBIDDEN"),
  );
  // 別Projectの子IDはNOT_FOUND。不正RoleはVALIDATION_ERROR。
  await assert.rejects(
    services.changeProjectMemberRoleUseCase.execute(owner.actor, projectQ.id, viewer.membershipId, { role: "editor" }),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(
    services.changeProjectMemberRoleUseCase.execute(owner.actor, projectP.id, viewer.membershipId, { role: "admin" }),
    rejectsWith("VALIDATION_ERROR"),
  );

  // 取消は次の呼出しから反映される。
  await services.revokeProjectMemberUseCase.execute(owner.actor, projectP.id, viewer.membershipId);
  await assert.rejects(services.listProjectMembersUseCase.execute(viewer.actor, projectP.id), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.revokeProjectMemberUseCase.execute(owner.actor, projectP.id, viewer.membershipId),
    rejectsWith("NOT_FOUND"),
  );
  await database.destroy();
});

test("最後のownerの降格・取消はLAST_OWNERで拒否し、他にownerがいれば自己降格できる", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const project = await services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);
  const [ownerMember] = await services.listProjectMembersUseCase.execute(owner.actor, project.id);
  const ownerMembershipId = ownerMember!.membership.id;

  const lastOwner = rejectsWith("CONFLICT", { conflict: "LAST_OWNER" });
  await assert.rejects(
    services.changeProjectMemberRoleUseCase.execute(owner.actor, project.id, ownerMembershipId, { role: "editor" }),
    lastOwner,
  );
  await assert.rejects(services.revokeProjectMemberUseCase.execute(owner.actor, project.id, ownerMembershipId), lastOwner);

  const second = await invite(services, owner.actor, project.id, "second@example.com", "administrator");
  await services.changeProjectMemberRoleUseCase.execute(owner.actor, project.id, second.membershipId, { role: "owner" });
  const demoted = await services.changeProjectMemberRoleUseCase.execute(owner.actor, project.id, ownerMembershipId, {
    role: "editor",
  });
  assert.equal(demoted.role, "editor");
  // 降格後は元ownerがRole変更できず、残ったownerは最後のownerとして保護される。
  await assert.rejects(
    services.changeProjectMemberRoleUseCase.execute(owner.actor, project.id, second.membershipId, { role: "viewer" }),
    rejectsWith("FORBIDDEN"),
  );
  await assert.rejects(
    services.revokeProjectMemberUseCase.execute(second.actor, project.id, second.membershipId),
    lastOwner,
  );
  await database.destroy();
});

test("招待はtoken hashだけを保存し、一度だけ受諾でき、期限切れ・取消・email不一致では登録しない", async () => {
  const { database, services, clock } = await setup();
  const owner = await bootstrapOwner(services);
  const project = await services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);

  const issued = await services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
    email: "  Member@Example.com ",
    role: "editor",
    expiresInHours: 2,
  });
  assert.equal(issued.invitation.email, "member@example.com");
  assert.equal(issued.invitation.expiresAt, clock.now + 2 * hour);
  assert.ok(!JSON.stringify(await database.selectFrom("project_invitation").selectAll().execute()).includes(issued.token));
  await assert.rejects(
    services.createProjectInvitationUseCase.execute(owner.actor, project.id, { email: "member@example.com", role: "viewer" }),
    rejectsWith("CONFLICT", { conflict: "INVITATION_PENDING" }),
  );
  await assert.rejects(
    services.createProjectInvitationUseCase.execute(owner.actor, project.id, { email: "x@example.com", role: "viewer", expiresInHours: 0 }),
    rejectsWith("VALIDATION_ERROR"),
  );

  // email不一致・未知tokenは`not_allowed`で、行を作らない。
  const before = await countRows(database);
  assert.deepEqual(
    await services.registerOrLoginHumanUseCase.execute({
      identity: google("intruder", "intruder@example.com"),
      invitationToken: issued.token,
    }),
    { kind: "rejected", reason: "not_allowed" },
  );
  assert.deepEqual(
    await services.registerOrLoginHumanUseCase.execute({
      identity: google("member-sub", "member@example.com"),
      invitationToken: "unknown-token",
    }),
    { kind: "rejected", reason: "not_allowed" },
  );
  assert.deepEqual(await countRows(database), before);

  const member = await login(services, google("member-sub", "member@example.com"), { invitationToken: issued.token });
  assert.equal(member.created, true);
  assert.equal(member.invitation, "accept");
  assert.equal(member.human.platformRole, "member");
  const membership = await services.humanProjectAuthorizationService.requireProjectRole(actorOf(member.human.id), project.id, "editor");
  assert.equal(membership.createdByHumanUserId, owner.human.id);

  // 使用済みtokenは既存Humanのログインでは受諾せず（ログインは成功）、新規Humanでは拒否する。
  const reused = await login(services, google("member-sub", "member@example.com"), { invitationToken: issued.token });
  assert.equal(reused.invitation, "invalid");
  assert.equal((await services.listProjectMembersUseCase.execute(owner.actor, project.id)).length, 2);

  // 期限切れは`invitation_expired`で区別し、行を作らない。
  const expiring = await services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
    email: "late@example.com",
    role: "viewer",
    expiresInHours: 1,
  });
  clock.now += hour;
  const beforeExpired = await countRows(database);
  assert.deepEqual(
    await services.registerOrLoginHumanUseCase.execute({ identity: google("late-sub", "late@example.com"), invitationToken: expiring.token }),
    { kind: "rejected", reason: "invitation_expired" },
  );
  assert.deepEqual(await countRows(database), beforeExpired);
  await assert.rejects(
    services.revokeProjectInvitationUseCase.execute(owner.actor, project.id, expiring.invitation.id),
    rejectsWith("CONFLICT", { conflict: "INVITATION_NOT_PENDING" }),
  );

  // 取消済み招待は受諾できない。
  const revocable = await services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
    email: "revoked@example.com",
    role: "viewer",
  });
  const revoked = await services.revokeProjectInvitationUseCase.execute(owner.actor, project.id, revocable.invitation.id);
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.revokedByHumanUserId, owner.human.id);
  assert.deepEqual(
    await services.registerOrLoginHumanUseCase.execute({
      identity: google("revoked-sub", "revoked@example.com"),
      invitationToken: revocable.token,
    }),
    { kind: "rejected", reason: "not_allowed" },
  );
  // 別Projectの招待IDはNOT_FOUND。
  const other = await services.createProjectUseCase.execute({ name: "Q", mission: "m" }, owner.actor);
  await assert.rejects(
    services.revokeProjectInvitationUseCase.execute(owner.actor, other.id, revocable.invitation.id),
    rejectsWith("NOT_FOUND"),
  );
  await database.destroy();
});

test("期限切れのpending招待がある宛先へ再発行でき、古い招待は取消扱いになって受諾できない", async () => {
  const { database, services, clock } = await setup();
  const owner = await bootstrapOwner(services);
  const project = await services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);
  const expired = await services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
    email: "late@example.com",
    role: "viewer",
    expiresInHours: 1,
  });
  clock.now += hour;

  const reissued = await services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
    email: "late@example.com",
    role: "editor",
  });
  const invitations = await services.listProjectInvitationsUseCase.execute(owner.actor, project.id);
  const statusOf = (id: string) => invitations.find((invitation) => invitation.id === id)?.status;
  assert.equal(statusOf(expired.invitation.id), "revoked");
  assert.equal(statusOf(reissued.invitation.id), "pending");

  assert.deepEqual(
    await services.registerOrLoginHumanUseCase.execute({ identity: google("late-sub", "late@example.com"), invitationToken: expired.token }),
    { kind: "rejected", reason: "not_allowed" },
  );
  const member = await login(services, google("late-sub", "late@example.com"), { invitationToken: reissued.token });
  assert.equal((await services.humanProjectAuthorizationService.requireProjectRole(actorOf(member.human.id), project.id, "editor")).role, "editor");
  await database.destroy();
});

test("既存Humanは招待で別Projectへ参加でき、既に所属するProjectの招待はpendingのまま残る", async () => {
  const { database, services } = await setup();
  const owner = await bootstrapOwner(services);
  const projectP = await services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);
  const projectQ = await services.createProjectUseCase.execute({ name: "Q", mission: "m" }, owner.actor);
  const member = await invite(services, owner.actor, projectP.id, "member@example.com", "viewer");

  const toQ = await services.createProjectInvitationUseCase.execute(owner.actor, projectQ.id, { email: "member@example.com", role: "editor" });
  const joined = await login(services, google("member@example.com-sub", "member@example.com"), { invitationToken: toQ.token });
  assert.equal(joined.invitation, "accept");
  assert.equal(joined.created, false);

  const again = await services.createProjectInvitationUseCase.execute(owner.actor, projectP.id, { email: "member@example.com", role: "owner" });
  const already = await login(services, google("member@example.com-sub", "member@example.com"), { invitationToken: again.token });
  assert.equal(already.invitation, "already_member");
  const invitation = (await services.listProjectInvitationsUseCase.execute(owner.actor, projectP.id)).find(({ id }) => id === again.invitation.id);
  assert.equal(invitation?.status, "pending");
  assert.equal((await services.humanProjectAuthorizationService.requireProjectRole(member.actor, projectP.id, "viewer")).role, "viewer");
  await database.destroy();
});

test("再起動後もIdentity・Membership・Invitation・Sessionの失効状態が保持される", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-human-auth-"));
  const path = join(directory, "compass.db");
  try {
    const first = await setup(path);
    const owner = await bootstrapOwner(first.services);
    const project = await first.services.createProjectUseCase.execute({ name: "P", mission: "m" }, owner.actor);
    const member = await invite(first.services, owner.actor, project.id, "member@example.com", "editor");
    const pending = await first.services.createProjectInvitationUseCase.execute(owner.actor, project.id, {
      email: "pending@example.com",
      role: "viewer",
    });
    await first.services.revokeHumanSessionUseCase.execute(owner.sessionToken);
    const live = await login(first.services, google("owner-sub", ownerEmail));
    await first.database.destroy();

    const second = await setup(path);
    const { services } = second;
    assert.equal(await services.resolveHumanSessionUseCase.execute(owner.sessionToken), null);
    assert.equal((await services.resolveHumanSessionUseCase.execute(live.sessionToken))?.human.id, owner.human.id);
    const relogin = await login(services, google("owner-sub", ownerEmail));
    assert.equal(relogin.human.id, owner.human.id);
    assert.equal((await services.humanProjectAuthorizationService.requireProjectRole(member.actor, project.id, "editor")).role, "editor");
    const invitations = await services.listProjectInvitationsUseCase.execute(owner.actor, project.id);
    assert.deepEqual(
      invitations.map(({ email, status }) => ({ email, status })).sort((a, b) => a.email.localeCompare(b.email)),
      [
        { email: "member@example.com", status: "accepted" },
        { email: pending.invitation.email, status: "pending" },
      ],
    );
    await second.database.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("登録判定表: 無効なHumanは拒否し、招待・初期ownerの条件を満たさなければnot_allowed", () => {
  const identity = google("s", "a@example.com");
  const base = { identity, existingHuman: null, platformOwnerExists: true, initialOwnerEmail: null, invitation: null, now: 0 };
  assert.deepEqual(decideRegistration({ ...base, existingHuman: { id: "h", status: "disabled" } }), {
    kind: "reject",
    reason: "not_allowed",
  });
  assert.deepEqual(decideRegistration({ ...base, platformOwnerExists: false, initialOwnerEmail: "A@example.com" }), {
    kind: "bootstrap",
  });
  assert.deepEqual(decideRegistration({ ...base, platformOwnerExists: false }), { kind: "reject", reason: "not_allowed" });
  assert.deepEqual(decideRegistration({ ...base, invitation: { found: false } }), { kind: "reject", reason: "not_allowed" });
});
