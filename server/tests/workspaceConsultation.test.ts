import assert from "node:assert/strict";
import test from "node:test";
import { humanWorkspacePermissions } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * Workspace相談と横断した判断待ち一覧。Workspace Direction RoleのAgentがMCPで相談し、Workspace MembershipのHumanがWeb APIで返信し、
 * Strategistが応答leaseのもとで結論を整理する。ProjectとWorkspaceのMembership・Grant・Runtime Credentialを互いに継承しないこと、
 * 横断一覧の絞り込み・件数・ページングが認可済みの集合だけに対して行われることを確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const clock = { now: 1_800_000_000_000 };

const open = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => clock.now);
  return { database, services, app: createApp(services) };
};
type Kit = Awaited<ReturnType<typeof open>>;

let rpcId = 0;
/** `principal`はtrusted-localのBearer Agent名、またはCredentialのtoken。 */
const callTool = async (app: App, name: string, args: object, principal?: string, activeRole?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};
const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};
const failure = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; conflict?: string; issues?: { path: string }[] };
};

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

const consultationInput = (overrides: object = {}) => ({
  title: "次の重点Outcome",
  question: "今期は導入速度と運用コストのどちらを優先するかを決めてください",
  blockingReason: "Mission・Principlesからは優先順位を決められず、次のOutcomeの選択が分岐します",
  options: [{ label: "導入速度" }, { label: "運用コスト" }],
  recommendation: "導入速度。既存の利用者からの要望が多い",
  impact: "Target Projectと評価の基準が変わります",
  requestId: next("create"),
  ...overrides,
});

type Humans = Record<"owner" | "wsAdmin" | "wsEditor" | "wsViewer" | "projectOnly" | "both" | "outsider", TestHuman>;

/**
 * 公開操作で用意するGiven。ownerがWeb APIでWorkspace A・Bと所属Projectを作り、Workspace Grant（strategist・researcher）と
 * Project Grant（manager・worker）を割り当てる。Workspace・ProjectのMembership（Roleの違い）はfixtureで置く。
 * `projectOnly`はProject A1のeditorだけ、`both`はWorkspace AのviewerとProject A1のviewer、`outsider`はどこにも属さない。
 */
const seed = async (kit: Kit) => {
  const owner = await createTestHuman(kit.database);
  const asOwner = requestAs(kit.app, owner);
  const workspace = async (name: string) =>
    (await json(await asOwner("/api/workspaces", post({ name, mission: `${name} helps teams decide` })))).workspace as { id: string };
  const project = async (workspaceId: string, name: string) =>
    (await json(await asOwner(`/api/workspaces/${workspaceId}/projects`, post({ name })))).project as { id: string; workspaceId: string };
  const workspaceA = await workspace("Workspace A");
  const workspaceB = await workspace("Workspace B");
  const projectA1 = await project(workspaceA.id, "Project A1");
  const projectB1 = await project(workspaceB.id, "Project B1");
  for (const [workspaceId, principalId, role] of [
    [workspaceA.id, "strategist-a", "strategist"], [workspaceA.id, "researcher-a", "researcher"], [workspaceB.id, "strategist-b", "strategist"],
  ] as const) {
    assert.equal((await asOwner(`/api/workspaces/${workspaceId}/grants`, post({ principalId, role }))).status, 201);
  }
  for (const [projectId, principalId, role] of [
    [projectA1.id, "manager-a", "manager"], [projectA1.id, "worker-a", "worker"], [projectB1.id, "manager-b", "manager"],
  ] as const) {
    assert.equal((await asOwner(`/api/projects/${projectId}/grants`, post({ principalId, role }))).status, 201);
  }
  const humans = { owner } as Humans;
  for (const [who, role] of [["wsAdmin", "administrator"], ["wsEditor", "editor"], ["wsViewer", "viewer"]] as const) {
    humans[who] = await createTestHuman(kit.database);
    await addTestWorkspaceMembership(kit.database, workspaceA.id, humans[who], role);
  }
  humans.projectOnly = await createTestHuman(kit.database);
  await addTestMembership(kit.database, projectA1.id, humans.projectOnly, "editor");
  humans.both = await createTestHuman(kit.database);
  await addTestWorkspaceMembership(kit.database, workspaceA.id, humans.both, "viewer");
  await addTestMembership(kit.database, projectA1.id, humans.both, "viewer");
  humans.outsider = await createTestHuman(kit.database);
  const as = (who: keyof Humans) => requestAs(kit.app, humans[who]);
  const intent = (await json(await asOwner(`/api/workspaces/${workspaceA.id}/intents`, post({
    title: "Adoption", desiredState: "Teams adopt Compass", completionDefinition: "Ten teams use it weekly",
  })))).intent as { id: string };
  const outcome = ok(await callTool(kit.app, "create_outcome", {
    workspaceId: workspaceA.id, intentId: intent.id, title: "Onboarding under a day", description: "New teams onboard quickly.",
    rationale: "Adoption depends on onboarding.", successCriteria: [{ description: "median onboarding < 1 day", measurement: "Survey" }],
  }, "strategist-a", "strategist")).outcome as { id: string };
  return { workspaceA, workspaceB, projectA1, projectB1, humans, as, intent, outcome };
};

type Seeded = Awaited<ReturnType<typeof seed>>;

const createWorkspaceConsultation = (kit: Kit, workspaceId: string, principal = "researcher-a", role = "researcher", overrides: object = {}) =>
  callTool(kit.app, "create_consultation", { workspaceId, ...consultationInput(overrides) }, principal, role);

const createProjectConsultation = (kit: Kit, projectId: string, overrides: object = {}) =>
  callTool(kit.app, "create_consultation", { projectId, ...consultationInput({ title: "認証方式", ...overrides }) }, "worker-a", "worker");

test("権限表: Workspace相談の参照はviewer、返信はeditor、明示決定・取消はadministrator以上（Workspace Membership）", () => {
  assert.equal(humanWorkspacePermissions["workspace.read"], "viewer");
  assert.equal(humanWorkspacePermissions["consultation.reply"], "editor");
  assert.equal(humanWorkspacePermissions["consultation.decide"], "administrator");
});

test("Workspace AgentがMCPで相談し、HumanがWebで返信し、Strategistが応答leaseのもとで結論を整理する", async () => {
  const kit = await open();
  try {
    const { workspaceA, projectA1, as, intent, outcome } = await seed(kit);
    const created = ok(await createWorkspaceConsultation(kit, workspaceA.id, "researcher-a", "researcher", {
      refs: [{ kind: "intent", id: intent.id }, { kind: "outcome", intentId: intent.id, id: outcome.id }, { kind: "url", url: "https://example.com/survey" }],
    })).consultation;
    assert.equal(created.scope, "workspace");
    assert.equal(created.workspaceId, workspaceA.id);
    assert.equal(created.projectId, null);
    assert.equal(created.status, "waiting_human");
    assert.deepEqual(created.createdBy, { kind: "agent", principalId: "researcher-a", role: "researcher" });

    // Workspace Membershipのviewerが一覧・詳細を読める。Projectの一覧には混ざらない。
    const base = `/api/workspaces/${workspaceA.id}/consultations`;
    assert.deepEqual((await json(await as("wsViewer")(`${base}?status=waiting_human`))).consultations.map((item: { id: string }) => item.id), [created.id]);
    assert.equal((await json(await as("wsViewer")(`${base}/${created.id}`))).consultation.refs.length, 3);
    assert.deepEqual((await json(await as("owner")(`/api/projects/${projectA1.id}/consultations`))).consultations, []);

    // 返信はeditor以上。viewerは403、Project Membershipだけ・未所属は404（Workspaceの存在を区別しない）。
    assert.equal((await as("wsViewer")(`${base}/${created.id}/messages`, post({ body: "x", requestId: next("reply") }))).status, 403);
    for (const who of ["projectOnly", "outsider"] as const) {
      assert.equal((await as(who)(`${base}/${created.id}`)).status, 404);
      assert.equal((await as(who)(`${base}/${created.id}/messages`, post({ body: "x", requestId: next("reply") }))).status, 404);
    }
    const replied = await as("wsEditor")(`${base}/${created.id}/messages`, post({ body: "導入速度を優先してください。運用コストは次の期に見直します", requestId: next("reply") }));
    assert.equal(replied.status, 201);
    const reply = await json(replied);
    assert.equal(reply.consultation.status, "waiting_agent");
    assert.equal(reply.message.author.kind, "human");

    // Workspace Runtime Credentialだけが応答待ち（ID・入力版）を読める。Project Runtime Credential・Agent Credential・Bearer名は拒否。
    const issue = async (path: string, body: object) => (await json(await as("owner")(path, post(body)))).token as string;
    const workspaceRuntime = await issue(`/api/workspaces/${workspaceA.id}/credentials`, { kind: "runtime", principalId: "orchestrator-a", scopes: ["runtime:state:read"] });
    const projectRuntime = await issue(`/api/projects/${projectA1.id}/credentials`, { kind: "runtime", principalId: "orchestrator-p", scopes: ["runtime:state:read"] });
    const state = ok(await callTool(kit.app, "get_workspace_consultation_state", { workspaceId: workspaceA.id }, workspaceRuntime));
    assert.deepEqual(state.consultations, [{ id: created.id, inputRevision: 2 }]);
    assert.equal(JSON.stringify(state).includes("導入速度"), false);
    assert.equal(failure(await callTool(kit.app, "get_workspace_consultation_state", { workspaceId: workspaceA.id }, projectRuntime)).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "get_workspace_consultation_state", { workspaceId: workspaceA.id }, "strategist-a", "strategist")).code, "FORBIDDEN");
    // Project側の応答待ちにWorkspace相談は含まれない。
    assert.deepEqual(ok(await callTool(kit.app, "get_project_consultation_state", { projectId: projectA1.id }, projectRuntime)).consultations, []);

    // 結論整理・取消はStrategistだけ。Researcher・Project ManagerはFORBIDDEN、他WorkspaceのStrategistもFORBIDDEN。
    const target = { workspaceId: workspaceA.id, consultationId: created.id };
    const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 2, requestId: next("lease") }, "strategist-a", "strategist")).lease;
    const resolution = {
      ...target, leaseId: lease.id, expectedRevision: 2, conclusion: "導入速度を優先する", rationale: "Humanの返信が明確", selectedOption: 0,
      basisMessageIds: [reply.message.id],
    };
    assert.equal(failure(await callTool(kit.app, "resolve_consultation", { ...resolution, requestId: next("resolve") }, "researcher-a", "researcher")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "resolve_consultation", { ...resolution, requestId: next("resolve") }, "manager-a", "manager")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "resolve_consultation", { ...resolution, requestId: next("resolve") }, "strategist-b", "strategist")).code, "FORBIDDEN");
    // 古い版はSTALE_REVISION。
    assert.equal(failure(await callTool(kit.app, "resolve_consultation", { ...resolution, expectedRevision: 1, requestId: next("resolve") }, "strategist-a", "strategist")).conflict, "STALE_REVISION");
    const resolveRequestId = next("resolve");
    const resolved = ok(await callTool(kit.app, "resolve_consultation", { ...resolution, requestId: resolveRequestId }, "strategist-a", "strategist"));
    assert.equal(resolved.consultation.status, "resolved");
    assert.equal(resolved.resolution.source, "agent_summary");
    assert.deepEqual(resolved.resolution.recordedBy, { kind: "agent", principalId: "strategist-a", role: "strategist" });
    // 同じrequestIdの再送は保存済みの結果を返し、二重に解決しない。
    assert.deepEqual(ok(await callTool(kit.app, "resolve_consultation", { ...resolution, requestId: resolveRequestId }, "strategist-a", "strategist")), resolved);
    assert.deepEqual(ok(await callTool(kit.app, "get_workspace_consultation_state", { workspaceId: workspaceA.id }, workspaceRuntime)).consultations, []);

    const detail = await json(await as("wsViewer")(`${base}/${created.id}`));
    assert.equal(detail.consultation.status, "resolved");
    assert.equal(detail.resolution.conclusion, "導入速度を優先する");
    assert.deepEqual(detail.messages.map((message: { author: { kind: string } }) => message.author.kind), ["human"]);
  } finally {
    await kit.database.destroy();
  }
});

test("scopeを継承・転送しない: Project GrantではWorkspace相談を、Workspace GrantではProject相談を扱えず、別scopeのIDはNOT_FOUND", async () => {
  const kit = await open();
  try {
    const { workspaceA, workspaceB, projectA1, intent, outcome } = await seed(kit);
    const workspaceConsultation = ok(await createWorkspaceConsultation(kit, workspaceA.id)).consultation;
    const projectConsultation = ok(await createProjectConsultation(kit, projectA1.id)).consultation;

    // Project Execution RoleのGrantはWorkspace相談に使えず、Workspace Direction RoleのGrantはProject相談に使えない。
    assert.equal(failure(await callTool(kit.app, "list_consultations", { workspaceId: workspaceA.id }, "manager-a", "manager")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "create_consultation", { workspaceId: workspaceA.id, ...consultationInput() }, "worker-a", "worker")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "list_consultations", { projectId: projectA1.id }, "strategist-a", "strategist")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "create_consultation", { projectId: projectA1.id, ...consultationInput() }, "strategist-a", "strategist")).code, "FORBIDDEN");
    // 他WorkspaceのGrantでは読めない。
    assert.equal(failure(await callTool(kit.app, "get_consultation", { workspaceId: workspaceA.id, consultationId: workspaceConsultation.id }, "strategist-b", "strategist")).code, "FORBIDDEN");

    // 同じWorkspaceでもscopeが違う相談IDは見つからない（Project相談をWorkspaceへ移して閲覧範囲を広げない）。
    assert.equal(failure(await callTool(kit.app, "get_consultation", { workspaceId: workspaceA.id, consultationId: projectConsultation.id }, "strategist-a", "strategist")).code, "NOT_FOUND");
    assert.equal(failure(await callTool(kit.app, "get_consultation", { projectId: projectA1.id, consultationId: workspaceConsultation.id }, "manager-a", "manager")).code, "NOT_FOUND");
    assert.equal(failure(await callTool(kit.app, "get_consultation", { workspaceId: workspaceB.id, consultationId: workspaceConsultation.id }, "strategist-b", "strategist")).code, "NOT_FOUND");
    assert.deepEqual(ok(await callTool(kit.app, "list_consultations", { workspaceId: workspaceA.id }, "strategist-a", "strategist")).consultations.map((item: { id: string }) => item.id), [workspaceConsultation.id]);
    // Workspace相談はTaskの待機に使えない（同じProjectのProject相談だけ。存在しない相談IDと同じく拒否する）。
    const task = ok(await callTool(kit.app, "issue_task", { projectId: projectA1.id, title: "待機できない", requestId: next("task") }, "worker-a", "worker"));
    const claim = ok(await callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("claim") }, "worker-a", "worker"));
    const runtime = { worktreePath: "/tmp/w", contextPath: "/tmp/c.json", headSha: "a".repeat(40), sourceFingerprint: "f", pullRequest: null, verificationRefs: [] };
    assert.equal(failure(await callTool(kit.app, "wait_for_consultation", { taskId: task.id, claimId: claim.claimId, consultationIds: [workspaceConsultation.id], reason: "r", runtime, requestId: next("wait") }, "worker-a", "worker")).code, "INVALID_INPUT");

    // scopeの指定は`projectId`・`workspaceId`のどちらか一方。
    assert.equal(failure(await callTool(kit.app, "list_consultations", { projectId: projectA1.id, workspaceId: workspaceA.id }, "strategist-a", "strategist")).code, "VALIDATION_ERROR");
    assert.equal(failure(await callTool(kit.app, "list_consultations", {}, "strategist-a", "strategist")).code, "VALIDATION_ERROR");
    // Roleはscopeに属するものだけ。
    assert.equal(failure(await callTool(kit.app, "create_consultation", { workspaceId: workspaceA.id, ...consultationInput(), role: "manager" }, "strategist-a")).code, "FORBIDDEN");

    // 参照はscopeの種類・所属だけ。WorkspaceにTask・Project Resourceは指せず、OutcomeはIntentとWorkspaceの一致を要する。
    const invalid = async (refs: object[]) => failure(await createWorkspaceConsultation(kit, workspaceA.id, "researcher-a", "researcher", { refs }));
    assert.equal((await invalid([{ kind: "task", id: task.id }])).code, "VALIDATION_ERROR");
    assert.equal((await invalid([{ kind: "project_resource", resourceId: "r" }])).code, "VALIDATION_ERROR");
    assert.equal((await invalid([{ kind: "outcome", intentId: "other-intent", id: outcome.id }])).code, "VALIDATION_ERROR");
    assert.equal((await invalid([{ kind: "consultation", id: projectConsultation.id }])).code, "VALIDATION_ERROR");
    const otherIntent = await failure(await createWorkspaceConsultation(kit, workspaceB.id, "strategist-b", "strategist", { refs: [{ kind: "intent", id: intent.id }] }));
    assert.equal(otherIntent.code, "VALIDATION_ERROR");
    assert.equal(failure(await createProjectConsultation(kit, projectA1.id, { refs: [{ kind: "intent", id: intent.id }] })).code, "VALIDATION_ERROR");
  } finally {
    await kit.database.destroy();
  }
});

test("Humanの返信・決定・取消はWorkspace Membershipで認可し、明示決定はhuman_decision、archivedのWorkspaceは参照だけ", async () => {
  const kit = await open();
  try {
    const { workspaceA, as } = await seed(kit);
    const base = `/api/workspaces/${workspaceA.id}/consultations`;
    const first = ok(await createWorkspaceConsultation(kit, workspaceA.id)).consultation;
    const second = ok(await createWorkspaceConsultation(kit, workspaceA.id, "strategist-a", "strategist")).consultation;
    const decision = { conclusion: "運用コストを優先", rationale: "予算の制約", expectedRevision: 1 };
    assert.equal((await as("wsEditor")(`${base}/${first.id}/resolution`, post({ ...decision, requestId: next("decide") }))).status, 403);
    assert.equal((await as("projectOnly")(`${base}/${first.id}/resolution`, post({ ...decision, requestId: next("decide") }))).status, 404);
    const decided = await as("wsAdmin")(`${base}/${first.id}/resolution`, post({ ...decision, requestId: next("decide") }));
    assert.equal(decided.status, 201);
    const resolution = (await json(decided)).resolution;
    assert.equal(resolution.source, "human_decision");
    assert.equal(resolution.recordedBy.kind, "human");
    assert.equal((await json(await as("wsAdmin")(`${base}/${first.id}/messages`, post({ body: "追記", requestId: next("reply") })))).error.conflict, "CONSULTATION_CLOSED");

    assert.equal((await as("wsEditor")(`${base}/${second.id}/cancel`, post({ reason: "不要", expectedRevision: 1, requestId: next("cancel") }))).status, 403);
    // 取消は応答Roleのstrategistだけ（Researcherは不可）。
    assert.equal(failure(await callTool(kit.app, "cancel_consultation", { workspaceId: workspaceA.id, consultationId: second.id, expectedRevision: 1, reason: "不要", requestId: next("cancel") }, "researcher-a", "researcher")).code, "FORBIDDEN");

    assert.equal((await as("owner")(`/api/workspaces/${workspaceA.id}/archive`, post({ reason: "終了" }))).status, 200);
    const archived = await as("wsEditor")(`${base}/${second.id}/messages`, post({ body: "まだ必要", requestId: next("reply") }));
    assert.equal(archived.status, 409);
    assert.equal((await json(archived)).error.workspaceStatus, "archived");
    assert.equal(failure(await createWorkspaceConsultation(kit, workspaceA.id)).code, "CONFLICT");
    assert.equal((await as("wsViewer")(`${base}/${second.id}`)).status, 200);
  } finally {
    await kit.database.destroy();
  }
});

/** 横断一覧の相談IDと`nextCursor`。 */
const inbox = async (seeded: Seeded, who: keyof Humans, query = "") => {
  const response = await seeded.as(who)(`/api/consultations${query}`);
  assert.equal(response.status, 200, await response.clone().text());
  const body = await json(response);
  return { ids: body.consultations.map((item: { id: string }) => item.id) as string[], nextCursor: body.nextCursor as string | null, body };
};

test("横断一覧は閲覧できるProject・Workspaceの相談だけを返し、絞り込み・ページングは認可済みの集合に対して行う", async () => {
  const kit = await open();
  try {
    const seeded = await seed(kit);
    const { workspaceA, workspaceB, projectA1, projectB1 } = seeded;
    const at = (offset: number) => { clock.now = 1_800_000_000_000 + offset; };
    at(1);
    const wsA = ok(await createWorkspaceConsultation(kit, workspaceA.id)).consultation;
    at(2);
    const pA1 = ok(await createProjectConsultation(kit, projectA1.id)).consultation;
    at(3);
    const wsB = ok(await createWorkspaceConsultation(kit, workspaceB.id, "strategist-b", "strategist", { title: "Workspace Bの秘密の題名" })).consultation;
    at(4);
    const pB1 = ok(await callTool(kit.app, "create_consultation", { projectId: projectB1.id, ...consultationInput({ title: "Project B1の秘密の題名" }) }, "manager-b", "manager")).consultation;
    at(5);
    const pA1Waiting = ok(await createProjectConsultation(kit, projectA1.id, { title: "返信済み" })).consultation;
    await seeded.as("owner")(`/api/projects/${projectA1.id}/consultations/${pA1Waiting.id}/messages`, post({ body: "回答", requestId: next("reply") }));

    // ownerは全scopeのMembershipを持つ。既定はHumanの判断待ちで、更新の新しい順。
    assert.deepEqual((await inbox(seeded, "owner")).ids, [pB1.id, wsB.id, pA1.id, wsA.id]);
    assert.deepEqual((await inbox(seeded, "owner", "?status=all")).ids, [pA1Waiting.id, pB1.id, wsB.id, pA1.id, wsA.id]);
    assert.deepEqual((await inbox(seeded, "owner", "?status=waiting_agent")).ids, [pA1Waiting.id]);
    assert.deepEqual((await inbox(seeded, "owner", "?scope=workspace")).ids, [wsB.id, wsA.id]);
    assert.deepEqual((await inbox(seeded, "owner", `?workspaceId=${workspaceA.id}`)).ids, [pA1.id, wsA.id]);
    assert.deepEqual((await inbox(seeded, "owner", `?projectId=${projectA1.id}&status=all`)).ids, [pA1Waiting.id, pA1.id]);
    assert.deepEqual((await inbox(seeded, "owner", `?scope=workspace&projectId=${projectA1.id}`)).ids, []);

    // Workspace Aのviewer（Project Membershipなし）はWorkspace Aの相談だけ。Project A1の相談は同じWorkspaceでも返さない。
    assert.deepEqual((await inbox(seeded, "wsViewer", "?status=all")).ids, [wsA.id]);
    // Project A1だけのHumanはProject A1の相談だけ。Workspace Aの相談は返さない。
    assert.deepEqual((await inbox(seeded, "projectOnly", "?status=all")).ids, [pA1Waiting.id, pA1.id]);
    assert.deepEqual((await inbox(seeded, "projectOnly", `?scope=workspace&workspaceId=${workspaceA.id}`)).ids, []);
    // 両方のMembershipがあれば両方を一緒に辿れる。
    assert.deepEqual((await inbox(seeded, "both")).ids, [pA1.id, wsA.id]);
    // 閲覧できないscopeを指定しても拒否せず空で、題名・件数・存在を区別させない。
    for (const query of [`?projectId=${projectB1.id}`, `?workspaceId=${workspaceB.id}`, "?projectId=missing", "?workspaceId=missing"]) {
      const { ids, nextCursor, body } = await inbox(seeded, "both", query);
      assert.deepEqual([ids, nextCursor], [[], null]);
      assert.equal(JSON.stringify(body).includes("秘密"), false);
    }
    const outsider = await inbox(seeded, "outsider", "?status=all");
    assert.deepEqual([outsider.ids, outsider.nextCursor], [[], null]);

    // ページングは認可済みの集合の中で続きを返し、未許可scopeの相談で欠番・件数が変わらない。
    const first = await inbox(seeded, "both", "?status=all&limit=1");
    assert.deepEqual(first.ids, [pA1Waiting.id]);
    assert.ok(first.nextCursor);
    const second = await inbox(seeded, "both", `?status=all&limit=1&cursor=${encodeURIComponent(first.nextCursor!)}`);
    assert.deepEqual(second.ids, [pA1.id]);
    const third = await inbox(seeded, "both", `?status=all&limit=1&cursor=${encodeURIComponent(second.nextCursor!)}`);
    assert.deepEqual([third.ids, third.nextCursor], [[wsA.id], null]);

    // 入力の不正は400。未認証は401。
    for (const query of ["?status=open", "?scope=global", "?limit=0", "?limit=101", "?cursor=broken"]) {
      assert.equal((await seeded.as("owner")(`/api/consultations${query}`)).status, 400, query);
    }
    assert.equal((await kit.app.request("/api/consultations")).status, 401);
  } finally {
    clock.now = 1_800_000_000_000;
    await kit.database.destroy();
  }
});
