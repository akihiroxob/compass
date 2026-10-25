import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { humanProjectPermissions } from "@compass/access";
import { consultationLeaseTtlMs } from "@compass/collaboration";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, seedProjectWorkspaceGrant, type TestHuman } from "./support/humanSession.ts";

/**
 * Project相談（Collaboration）。AgentがMCPで質問・選択肢・推奨を登録し、HumanがWeb APIで読み返信し、Managerが会話から結論を保存する。
 * Membership・Execution Role Grantによる認可、別Projectの隔離、版・応答lease・requestIdによる不正な更新・重複の防止、
 * 記録主体と判断の由来の区別、同じschemaでの再起動後の保持を確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const clock = { now: 1_800_000_000_000 };

const open = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => clock.now);
  return { database, services, app: createApp(services) };
};
type Kit = Awaited<ReturnType<typeof open>>;

let rpcId = 0;
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
  return result.structuredContent.error as { code: string; conflict?: string; currentRevision?: string };
};

const json = async (response: Response) => (await response.json()) as Record<string, any>;
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

type Humans = Record<"owner" | "administrator" | "editor" | "viewer" | "outsider", TestHuman>;

/**
 * 公開操作で用意するGiven。ownerがWeb APIでProjectを作り、Role割当（Worker / Reviewer / Manager Grant）を行う。
 * administrator・editor・viewerのMembershipと未所属Humanはfixtureで置く（招待・受諾の公開操作は別の検証範囲）。
 */
const seed = async (kit: Kit, name = "Compass") => {
  const owner = await createTestHuman(kit.database);
  const asOwner = requestAs(kit.app, owner);
  const created = await json(await asOwner("/api/projects", post({
    name,
    mission: "Agents ask Humans when they cannot decide",
    repositories: [{ name: "primary", url: "https://example.com/compass.git" }],
  })));
  const project = created.project as { id: string; workspaceId: string; repositories: { id: string }[] };
  for (const [principalId, role] of [["manager-a", "manager"], ["worker-a", "worker"], ["reviewer-a", "reviewer"], ["manager-b", "manager"]]) {
    assert.equal((await asOwner(`/api/projects/${project.id}/grants`, post({ principalId, role }))).status, 201);
  }
  const humans = { owner } as Humans;
  for (const role of ["administrator", "editor", "viewer"] as const) {
    humans[role] = await createTestHuman(kit.database);
    await addTestMembership(kit.database, project.id, humans[role], role);
  }
  humans.outsider = await createTestHuman(kit.database);
  const as = (who: keyof Humans) => requestAs(kit.app, humans[who]);
  return { project, humans, as };
};

const consultationInput = (overrides: object = {}) => ({
  title: "認証方式の選択",
  question: "外部IdPをOIDCにするかSAMLにするかを決めてください",
  blockingReason: "ログイン実装の設計がこの選択で分岐し、既存の要件からは決められません",
  options: [{ label: "OIDC", description: "Google Workspaceと統合しやすい" }, { label: "SAML" }],
  recommendation: "OIDC。既存のGoogle OIDC実装を再利用できる",
  impact: "ログイン・Session・招待の実装範囲が変わります",
  requestId: next("create"),
  ...overrides,
});

const create = (kit: Kit, projectId: string, principal = "worker-a", overrides: object = {}) =>
  callTool(kit.app, "create_consultation", { projectId, ...consultationInput(overrides) }, principal, "worker");

test("権限表: 相談の参照はviewer、返信はeditor、明示決定・取消はadministrator以上", () => {
  assert.equal(humanProjectPermissions["project.read"], "viewer");
  assert.equal(humanProjectPermissions["consultation.reply"], "editor");
  assert.equal(humanProjectPermissions["consultation.decide"], "administrator");
});

test("Agentが質問を登録し、HumanがWebで返信し、Managerが会話から結論を保存して解決する（waiting_human→waiting_agent→waiting_human→waiting_agent→resolved）", async () => {
  const kit = await open();
  const { project, humans, as } = await seed(kit);
  const created = ok(await create(kit, project.id, "worker-a", {
    refs: [
      { kind: "project_resource", resourceId: project.repositories[0]!.id, path: "docs/auth.md", revision: "abc123" },
      { kind: "url", url: "https://openid.net/specs" },
    ],
  })).consultation;
  assert.equal(created.status, "waiting_human");
  assert.equal(created.revision, 1);
  assert.equal(created.projectId, project.id);
  assert.equal(created.workspaceId, project.workspaceId);
  assert.deepEqual(created.createdBy, { kind: "agent", principalId: "worker-a", role: "worker" });
  assert.deepEqual(created.options, [{ label: "OIDC", description: "Google Workspaceと統合しやすい" }, { label: "SAML", description: null }]);

  // viewerは一覧（既定はすべて、statusで絞れる）・詳細で質問・推奨・影響・参照を読める。
  const waiting = await json(await as("viewer")(`/api/projects/${project.id}/consultations?status=waiting_human`));
  assert.deepEqual(waiting.consultations.map((item: { id: string }) => item.id), [created.id]);
  const detailPath = `/api/projects/${project.id}/consultations/${created.id}`;
  const viewed = await json(await as("viewer")(detailPath));
  assert.equal(viewed.consultation.recommendation, created.recommendation);
  assert.equal(viewed.consultation.refs.length, 2);
  assert.deepEqual(viewed.messages, []);
  assert.equal(viewed.resolution, null);

  // editorの返信でAgentの応答待ちへ進む。発言者はSessionのHumanで、本文では偽れない。
  const replied = await as("editor")(`${detailPath}/messages`, post({ body: "OIDCの場合、招待の扱いはどうなりますか？", requestId: next("reply") }));
  assert.equal(replied.status, 201);
  const firstReply = await json(replied);
  assert.equal(firstReply.consultation.status, "waiting_agent");
  assert.equal(firstReply.consultation.revision, 2);
  assert.deepEqual(firstReply.message.author, { kind: "human", principalId: `human:${humans.editor.humanUserId}`, role: "operator" });

  // Agentの追加回答（応答leaseと現在の版が必要）でHumanの判断待ちへ戻る。
  const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId: created.id, inputRevision: 2, requestId: next("lease") }, "worker-a", "worker")).lease;
  assert.equal(lease.inputRevision, 2);
  assert.equal(lease.expiresAt, clock.now + consultationLeaseTtlMs);
  const answered = ok(await callTool(kit.app, "reply_consultation", {
    projectId: project.id, consultationId: created.id, leaseId: lease.id, expectedRevision: 2,
    body: "招待はemail照合のまま使えます。OIDCで問題ありませんか？", requestId: next("answer"),
  }, "worker-a", "worker"));
  assert.equal(answered.consultation.status, "waiting_human");
  assert.equal(answered.consultation.revision, 3);
  assert.equal(answered.message.author.kind, "agent");

  // Humanの明確な返信を根拠に、Managerが結論を整理して解決する（再承認は求めない）。
  const decisionReply = await json(await as("editor")(`${detailPath}/messages`, post({ body: "OIDCで進めてください", requestId: next("reply") })));
  assert.equal(decisionReply.consultation.status, "waiting_agent");
  const managerLease = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId: created.id, inputRevision: 4, requestId: next("lease") }, "manager-a", "manager")).lease;
  const resolved = ok(await callTool(kit.app, "resolve_consultation", {
    projectId: project.id, consultationId: created.id, leaseId: managerLease.id, expectedRevision: 4,
    conclusion: "外部IdPはOIDCとする", rationale: "Humanが返信でOIDCを指示した", applicability: "Human認証",
    selectedOption: 0, basisMessageIds: [decisionReply.message.id], requestId: next("resolve"),
  }, "manager-a", "manager"));
  assert.equal(resolved.consultation.status, "resolved");
  assert.equal(resolved.consultation.revision, 5);
  assert.equal(resolved.resolution.source, "agent_summary");
  assert.deepEqual(resolved.resolution.recordedBy, { kind: "agent", principalId: "manager-a", role: "manager" });
  assert.equal(resolved.resolution.basisRevision, 4);
  assert.deepEqual(resolved.resolution.basisMessageIds, [decisionReply.message.id]);

  // 一覧・詳細で会話と結論を追え、Human発言とAgentの発言・要約が区別される。
  const detail = await json(await as("viewer")(detailPath));
  assert.equal(detail.consultation.status, "resolved");
  assert.deepEqual(detail.messages.map((message: { author: { kind: string } }) => message.author.kind), ["human", "agent", "human"]);
  assert.deepEqual(detail.messages.map((message: { sequence: number }) => message.sequence), [1, 2, 3]);
  assert.equal(detail.resolution.source, "agent_summary");
  assert.equal(detail.responder, null);
  assert.deepEqual((await json(await as("viewer")(`/api/projects/${project.id}/consultations?status=resolved`))).consultations.map((item: { id: string }) => item.id), [created.id]);
  // MCPからも同じ内容を読める。
  assert.deepEqual(ok(await callTool(kit.app, "get_consultation", { projectId: project.id, consultationId: created.id }, "reviewer-a", "reviewer")), detail);

  // 解決済みの相談には追記できず、方針変更は元の相談を参照する新しい相談にする。
  const closed = await as("editor")(`${detailPath}/messages`, post({ body: "やはりSAMLで", requestId: next("reply") }));
  assert.equal(closed.status, 409);
  assert.equal((await json(closed)).error.conflict, "CONSULTATION_CLOSED");
  const superseding = ok(await create(kit, project.id, "worker-a", { supersedesConsultationId: created.id, refs: [{ kind: "consultation", id: created.id }] })).consultation;
  assert.equal(superseding.supersedesConsultationId, created.id);
  assert.equal(superseding.status, "waiting_human");
  await kit.database.destroy();
});

test("administratorは明示決定を記録でき、human_decisionとしてHumanが記録主体になる。AgentはHumanの決定を記録できない", async () => {
  const kit = await open();
  const { project, humans, as } = await seed(kit);
  const consultation = ok(await create(kit, project.id)).consultation;
  const path = `/api/projects/${project.id}/consultations/${consultation.id}`;
  const decision = { conclusion: "SAMLとする", rationale: "取引先の要件", selectedOption: 1, expectedRevision: 1, requestId: next("decide") };

  // editorは返信できるが決定・取消はできない。viewerは返信もできない。
  assert.equal((await as("editor")(`${path}/resolution`, post(decision))).status, 403);
  assert.equal((await as("editor")(`${path}/cancel`, post({ reason: "不要", expectedRevision: 1, requestId: next("cancel") }))).status, 403);
  assert.equal((await as("viewer")(`${path}/messages`, post({ body: "見ました", requestId: next("reply") }))).status, 403);

  // 明確な決定は再承認なしで解決する。Humanの決定は返信待ち（waiting_human）からも記録できる。
  const decided = await as("administrator")(`${path}/resolution`, post(decision));
  assert.equal(decided.status, 201);
  const body = await json(decided);
  assert.equal(body.consultation.status, "resolved");
  assert.equal(body.resolution.source, "human_decision");
  assert.deepEqual(body.resolution.recordedBy, { kind: "human", principalId: `human:${humans.administrator.humanUserId}`, role: "operator" });
  assert.equal(body.resolution.selectedOption, 1);

  // Agentは入力で由来を指定できず（未知の項目は拒否）、Humanの決定の入口もMCPに無い。
  const other = ok(await create(kit, project.id)).consultation;
  await as("editor")(`/api/projects/${project.id}/consultations/${other.id}/messages`, post({ body: "どちらでも", requestId: next("reply") }));
  const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId: other.id, inputRevision: 2, requestId: next("lease") }, "manager-a", "manager")).lease;
  const forged = failure(await callTool(kit.app, "resolve_consultation", {
    projectId: project.id, consultationId: other.id, leaseId: lease.id, expectedRevision: 2,
    conclusion: "OIDC", rationale: "Humanが決めた", basisMessageIds: [], source: "human_decision", requestId: next("resolve"),
  }, "manager-a", "manager"));
  assert.equal(forged.code, "VALIDATION_ERROR");
  // Humanの発言を根拠にしない結論はAgentだけで確定できない。
  const agentOnly = ok(await callTool(kit.app, "get_consultation", { projectId: project.id, consultationId: other.id }, "manager-a", "manager"));
  const humanMessageId = agentOnly.messages[0].id as string;
  assert.equal(agentOnly.messages[0].author.kind, "human");
  const tools = (await (await kit.app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: "Bearer manager-a" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
  })).text());
  assert.ok(!/decide_consultation|human_decision_consultation/.test(tools));
  const resolved = ok(await callTool(kit.app, "resolve_consultation", {
    projectId: project.id, consultationId: other.id, leaseId: lease.id, expectedRevision: 2,
    conclusion: "OIDC", rationale: "Humanはどちらでもよいと返信したため推奨を採用", basisMessageIds: [humanMessageId], requestId: next("resolve"),
  }, "manager-a", "manager"));
  assert.equal(resolved.resolution.source, "agent_summary");
  // DBでも由来と記録主体の不一致を拒否する。
  await assert.rejects(
    kit.database.updateTable("consultation_resolution").set({ source: "human_decision" }).where("id", "=", resolved.resolution.id).execute(),
    /CHECK constraint failed/,
  );
  await kit.database.destroy();
});

test("権限不足・別Project・未所属・Grant無しのAgentには相談を作成・参照・更新させず、存在も漏らさない", async () => {
  const kit = await open();
  const { project, as } = await seed(kit);
  const other = await seed(kit, "Other");
  const consultation = ok(await create(kit, project.id)).consultation;
  const path = `/api/projects/${project.id}/consultations/${consultation.id}`;

  // 未所属のHumanは一覧・詳細とも404（存在を区別しない）。
  assert.equal((await as("outsider")(`/api/projects/${project.id}/consultations`)).status, 404);
  assert.equal((await as("outsider")(path)).status, 404);
  // 別ProjectのMemberが別ProjectのIDで指しても見えない。
  assert.equal((await other.as("owner")(`/api/projects/${other.project.id}/consultations/${consultation.id}`)).status, 404);
  assert.deepEqual((await json(await other.as("owner")(`/api/projects/${other.project.id}/consultations`))).consultations, []);

  // Grant無しのAgentは参照・作成できない（FORBIDDEN）。別ProjectのGrantで別ProjectのIDとして指しても見えない。
  assert.equal(failure(await callTool(kit.app, "list_consultations", { projectId: project.id }, "stranger")).code, "FORBIDDEN");
  assert.equal(failure(await callTool(kit.app, "get_consultation", { projectId: project.id, consultationId: consultation.id }, "stranger", "worker")).code, "FORBIDDEN");
  assert.equal(failure(await callTool(kit.app, "get_consultation", { projectId: other.project.id, consultationId: consultation.id }, "worker-a", "worker")).code, "NOT_FOUND");
  assert.equal(failure(await create(kit, project.id, "stranger")).code, "FORBIDDEN");
  // Workspace Direction RoleのGrantはProjectの相談に継承しない。
  await seedProjectWorkspaceGrant(kit.database, project.id, "strategist-a", "strategist");
  assert.equal(failure(await callTool(kit.app, "list_consultations", { projectId: project.id }, "strategist-a")).code, "FORBIDDEN");
  assert.equal(failure(await callTool(kit.app, "list_consultations", { projectId: project.id }, "strategist-a", "strategist")).code, "FORBIDDEN");
  // 相談の作成はRoleの指定（activeRoleまたはrole）が必要。
  assert.equal(failure(await callTool(kit.app, "create_consultation", { projectId: project.id, ...consultationInput() }, "worker-a")).code, "VALIDATION_ERROR");
  assert.equal(ok(await callTool(kit.app, "create_consultation", { projectId: project.id, role: "worker", ...consultationInput() }, "worker-a")).consultation.createdBy.role, "worker");
  // 別Projectの参照先・存在しない参照は受け付けない。
  const foreignRef = failure(await create(kit, project.id, "worker-a", { refs: [{ kind: "project_resource", resourceId: other.project.repositories[0]!.id }] }));
  assert.equal(foreignRef.code, "VALIDATION_ERROR");
  assert.equal(failure(await create(kit, project.id, "worker-a", { refs: [{ kind: "task", id: "missing" }] })).code, "VALIDATION_ERROR");

  // 結論整理・取消はmanagerだけ。worker・reviewerは拒否する。
  await as("editor")(`${path}/messages`, post({ body: "OIDCで", requestId: next("reply") }));
  const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId: consultation.id, inputRevision: 2, requestId: next("lease") }, "worker-a", "worker")).lease;
  const resolveInput = { projectId: project.id, consultationId: consultation.id, leaseId: lease.id, expectedRevision: 2, conclusion: "OIDC", rationale: "返信", basisMessageIds: ["x"], requestId: next("resolve") };
  assert.equal(failure(await callTool(kit.app, "resolve_consultation", resolveInput, "worker-a", "worker")).code, "FORBIDDEN");
  assert.equal(failure(await callTool(kit.app, "resolve_consultation", resolveInput, "worker-a")).code, "FORBIDDEN");
  assert.equal(failure(await callTool(kit.app, "cancel_consultation", { projectId: project.id, consultationId: consultation.id, expectedRevision: 2, reason: "x", requestId: next("cancel") }, "reviewer-a", "reviewer")).code, "FORBIDDEN");
  await kit.database.destroy();
});

test("古いrevision・多重応答・期限切れlease・同じrequestIdの再送で会話・結論が重複しない", async () => {
  const kit = await open();
  const { project, as } = await seed(kit);
  const consultation = ok(await create(kit, project.id)).consultation;
  const path = `/api/projects/${project.id}/consultations/${consultation.id}`;
  const target = { projectId: project.id, consultationId: consultation.id };

  // Humanの返信待ちではleaseを取れない（応答すべきHumanの入力が無い）。
  assert.equal(failure(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 1, requestId: next("lease") }, "worker-a", "worker")).conflict, "NOT_WAITING_AGENT");

  // 同じrequestIdの再送は1件に収束し、別内容での再利用は拒否する。
  const replyInput = { body: "SAMLは必要ですか？", requestId: next("reply") };
  const first = await json(await as("editor")(`${path}/messages`, post(replyInput)));
  const again = await as("editor")(`${path}/messages`, post(replyInput));
  assert.equal(again.status, 201);
  assert.deepEqual(await json(again), first);
  const reused = await as("editor")(`${path}/messages`, post({ ...replyInput, body: "別の内容" }));
  assert.equal(reused.status, 409);
  assert.equal((await json(reused)).error.conflict, "IDEMPOTENCY_CONFLICT");
  assert.equal((await json(await as("viewer")(path))).messages.length, 1);

  // 多重応答: 別のAgentが同じ入力版のleaseを持つ間は取得できない。古い入力版も拒否する。
  const leaseRequest = { ...target, inputRevision: 2, requestId: next("lease") };
  const lease = ok(await callTool(kit.app, "acquire_consultation_lease", leaseRequest, "manager-a", "manager")).lease;
  assert.deepEqual(ok(await callTool(kit.app, "acquire_consultation_lease", leaseRequest, "manager-a", "manager")).lease, lease);
  assert.equal(failure(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 2, requestId: next("lease") }, "manager-b", "manager")).conflict, "LEASE_HELD");
  assert.equal(failure(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 1, requestId: next("lease") }, "manager-b", "manager")).conflict, "STALE_REVISION");
  // leaseを持たないAgentは応答できない。
  assert.equal(failure(await callTool(kit.app, "reply_consultation", { ...target, leaseId: lease.id, expectedRevision: 2, body: "横取り", requestId: next("answer") }, "manager-b", "manager")).conflict, "LEASE_NOT_HELD");

  // 応答中にHumanが追加で返信すると版が進み、古い版での応答・解決は拒否される。
  const added = await json(await as("editor")(`${path}/messages`, post({ body: "補足: 取引先はOIDC非対応です", requestId: next("reply") })));
  assert.equal(added.consultation.revision, 3);
  const stale = failure(await callTool(kit.app, "resolve_consultation", {
    ...target, leaseId: lease.id, expectedRevision: 2, conclusion: "OIDC", rationale: "古い会話", basisMessageIds: [first.message.id], requestId: next("resolve"),
  }, "manager-a", "manager"));
  assert.equal(stale.conflict, "STALE_REVISION");
  assert.equal(stale.currentRevision, "3");
  // 現在の版を指定しても、leaseの入力版が古ければ拒否する（新しい入力を読んでleaseを取り直す）。
  assert.equal(failure(await callTool(kit.app, "reply_consultation", { ...target, leaseId: lease.id, expectedRevision: 3, body: "古いlease", requestId: next("answer") }, "manager-a", "manager")).conflict, "STALE_REVISION");

  // 期限切れのleaseでは応答できず、他のAgentが取り直せる。
  const renewed = ok(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 3, requestId: next("lease") }, "manager-a", "manager")).lease;
  clock.now += consultationLeaseTtlMs;
  assert.equal(failure(await callTool(kit.app, "reply_consultation", { ...target, leaseId: renewed.id, expectedRevision: 3, body: "遅い応答", requestId: next("answer") }, "manager-a", "manager")).conflict, "LEASE_EXPIRED");
  const takeover = ok(await callTool(kit.app, "acquire_consultation_lease", { ...target, inputRevision: 3, requestId: next("lease") }, "manager-b", "manager")).lease;

  // 解決は1回だけ。同じrequestIdの再送は同じ結論を返し、別のrequestIdの二重解決は拒否する。
  const resolveInput = {
    ...target, leaseId: takeover.id, expectedRevision: 3, conclusion: "SAMLとする", rationale: "取引先がOIDC非対応",
    basisMessageIds: [added.message.id], requestId: next("resolve"),
  };
  const resolved = ok(await callTool(kit.app, "resolve_consultation", resolveInput, "manager-b", "manager"));
  assert.deepEqual(ok(await callTool(kit.app, "resolve_consultation", resolveInput, "manager-b", "manager")), resolved);
  assert.equal(failure(await callTool(kit.app, "resolve_consultation", { ...resolveInput, requestId: next("resolve") }, "manager-b", "manager")).conflict, "CONSULTATION_CLOSED");
  const decided = await as("administrator")(`${path}/resolution`, post({ conclusion: "OIDC", rationale: "x", expectedRevision: 4, requestId: next("decide") }));
  assert.equal(decided.status, 409);
  assert.equal((await kit.database.selectFrom("consultation_resolution").selectAll().execute()).length, 1);
  await kit.database.destroy();
});

test("同時の返信再送・lease取得・解決でも発言と結論は1件に収束する", async () => {
  const kit = await open();
  try {
    const { project, as } = await seed(kit);
    const consultation = ok(await create(kit, project.id)).consultation;
    const target = { projectId: project.id, consultationId: consultation.id };
    const path = `/api/projects/${project.id}/consultations/${consultation.id}`;
    const reply = { body: "OIDCで進めてください", requestId: next("concurrent-reply") };
    const replies = await Promise.all(Array.from({ length: 3 }, () => as("editor")(`${path}/messages`, post(reply))));
    for (const response of replies) assert.equal(response.status, 201);
    const bodies = await Promise.all(replies.map(json));
    for (const body of bodies) assert.deepEqual(body, bodies[0]);

    const principals = ["manager-a", "manager-b"];
    const leases = await Promise.all(principals.map((principal) => callTool(kit.app, "acquire_consultation_lease", {
      ...target, inputRevision: 2, requestId: next("concurrent-lease"),
    }, principal, "manager")));
    const winner = leases.findIndex((result) => !result.isError);
    assert.notEqual(winner, -1);
    assert.equal(leases.filter((result) => !result.isError).length, 1);
    assert.equal(failure(leases[1 - winner]!).conflict, "LEASE_HELD");
    const lease = ok(leases[winner]!).lease;
    const resolution = {
      ...target, leaseId: lease.id, expectedRevision: 2, conclusion: "OIDCを採用する",
      rationale: "Humanの返信", basisMessageIds: [bodies[0]!.message.id], requestId: next("concurrent-resolve"),
    };
    const resolved = await Promise.all(Array.from({ length: 3 }, () => callTool(kit.app, "resolve_consultation", resolution, principals[winner], "manager")));
    for (const result of resolved) assert.deepEqual(ok(result), ok(resolved[0]!));
    const detail = await json(await as("viewer")(path));
    assert.equal(detail.messages.length, 1);
    assert.equal(detail.consultation.revision, 3);
    assert.equal(detail.resolution.source, "agent_summary");
    assert.equal((await kit.database.selectFrom("consultation_resolution").selectAll().execute()).length, 1);
  } finally {
    await kit.database.destroy();
  }
});

test("取消は理由と現在の版が必要で、取消後は追記・解決できない。archivedのProjectでは記録できない", async () => {
  const kit = await open();
  const { project, humans, as } = await seed(kit);
  const consultation = ok(await create(kit, project.id)).consultation;
  const path = `/api/projects/${project.id}/consultations/${consultation.id}`;
  assert.equal((await as("administrator")(`${path}/cancel`, post({ reason: " ", expectedRevision: 1, requestId: next("cancel") }))).status, 400);
  const stale = await as("administrator")(`${path}/cancel`, post({ reason: "要件が取り下げられた", expectedRevision: 2, requestId: next("cancel") }));
  assert.equal(stale.status, 409);
  assert.equal((await json(stale)).error.conflict, "STALE_REVISION");
  const canceled = await json(await as("administrator")(`${path}/cancel`, post({ reason: "要件が取り下げられた", expectedRevision: 1, requestId: next("cancel") })));
  assert.equal(canceled.consultation.status, "canceled");
  assert.deepEqual(canceled.consultation.cancellation.by, { kind: "human", principalId: `human:${humans.administrator.humanUserId}`, role: "operator" });
  assert.equal((await as("editor")(`${path}/messages`, post({ body: "まだ？", requestId: next("reply") }))).status, 409);

  // Managerの取消（Agent）。
  const second = ok(await create(kit, project.id)).consultation;
  const agentCanceled = ok(await callTool(kit.app, "cancel_consultation", { projectId: project.id, consultationId: second.id, expectedRevision: 1, reason: "別の相談で扱う", requestId: next("cancel") }, "manager-a", "manager"));
  assert.equal(agentCanceled.consultation.cancellation.by.kind, "agent");

  // archivedのProjectでは参照だけでき、作成・返信は拒否する。
  const third = ok(await create(kit, project.id)).consultation;
  assert.equal((await as("owner")(`/api/projects/${project.id}/archive`, post({ reason: "終了" }))).status, 200);
  const archivedReply = await as("editor")(`/api/projects/${project.id}/consultations/${third.id}/messages`, post({ body: "x", requestId: next("reply") }));
  assert.equal(archivedReply.status, 409);
  assert.equal((await json(archivedReply)).error.projectStatus, "archived");
  assert.equal(failure(await create(kit, project.id)).code, "CONFLICT");
  assert.equal((await json(await as("viewer")(`/api/projects/${project.id}/consultations`))).consultations.length, 3);
  await kit.database.destroy();
});

test("Message・結論は同じschemaでの再起動後も保持される", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-consultation-"));
  const path = join(directory, "compass.db");
  try {
    const first = await open(path);
    const { project, humans } = await seed(first);
    const consultation = ok(await create(first, project.id)).consultation;
    const detailPath = `/api/projects/${project.id}/consultations/${consultation.id}`;
    await requestAs(first.app, humans.editor)(`${detailPath}/messages`, post({ body: "OIDCで", requestId: next("reply") }));
    await requestAs(first.app, humans.administrator)(`${detailPath}/resolution`, post({ conclusion: "OIDC", rationale: "Humanの指示", expectedRevision: 2, requestId: next("decide") }));
    const before = await json(await requestAs(first.app, humans.viewer)(detailPath));
    await first.database.destroy();

    const second = await open(path);
    const after = await json(await requestAs(second.app, humans.viewer)(detailPath));
    assert.deepEqual(after, before);
    assert.equal(after.messages[0].author.kind, "human");
    assert.equal(after.resolution.source, "human_decision");
    await second.database.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("MCP相談待ち→Human返信→Manager結論→元WorkerのClaim再取得を公開入口で接続する", async () => {
  const kit = await open();
  try {
    const { project, as } = await seed(kit);
    const task = ok(await callTool(kit.app, "issue_task", { projectId: project.id, title: "相談して続ける", requestId: next("task") }, "worker-a", "worker"));
    const claimed = ok(await callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("claim") }, "worker-a", "worker"));
    const created = ok(await create(kit, project.id, "worker-a", { refs: [{ kind: "task", id: task.id }] }));
    const id = created.consultation.id;
    const runtime = { worktreePath: "/tmp/saved-worktree", contextPath: "/tmp/saved-context.json", headSha: "a".repeat(40), sourceFingerprint: "dirty-worktree-and-context", pullRequest: null, verificationRefs: ["test-log"] };
    const waited = ok(await callTool(kit.app, "wait_for_consultation", { taskId: task.id, claimId: claimed.claimId, consultationIds: [id], reason: "仕様の判断が必要", runtime, requestId: next("wait") }, "worker-a", "worker"));
    assert.equal(waited.status, "doing");
    assert.equal(failure(await callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("steal") }, "worker-a", "worker")).code, "TASK_NOT_CLAIMABLE");
    const detail = await json(await as("viewer")(`/api/projects/${project.id}/tasks/${task.id}`));
    assert.equal(detail.task.consultationWait.state, "waiting");
    assert.equal(detail.task.reclaimable, false);
    assert.equal(detail.task.consultationWait.consultations[0].id, id);
    const reply = await json(await as("editor")(`/api/projects/${project.id}/consultations/${id}/messages`, post({ body: "案Aで実装してください", requestId: next("reply") })));
    const pending = ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker"));
    assert.equal(pending.resumptions[0].state, "waiting");
    const leased = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId: id, inputRevision: reply.consultation.revision, requestId: next("lease") }, "manager-a", "manager"));
    ok(await callTool(kit.app, "resolve_consultation", { projectId: project.id, consultationId: id, leaseId: leased.lease.id, expectedRevision: reply.consultation.revision,
      conclusion: "案Aで進める", rationale: "Humanの明確な回答に従う", basisMessageIds: [reply.message.id], requestId: next("resolve") }, "manager-a", "manager"));
    const ready = ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker"));
    assert.equal(ready.resumptions[0].state, "ready");
    assert.ok(ready.resumptions[0].consultations[0].resolutionId);
    assert.equal(ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "reviewer-a", "reviewer")).resumptions.length, 0);
    const resumed = ok(await callTool(kit.app, "resume_consultation_task", { taskId: task.id, runtime, requestId: next("resume") }, "worker-a", "worker"));
    assert.equal(resumed.phase, "work");
    assert.equal(resumed.taskStatus, "doing");
    assert.notEqual(resumed.claimId, claimed.claimId);
    assert.equal(resumed.task.title, "相談して続ける");
    assert.equal(failure(await callTool(kit.app, "renew_claim", { claimId: claimed.claimId }, "worker-a", "worker")).code, "CLAIM_EXPIRED");
    // Runtime読取はAgent Credentialとは分離。Roleを足してもRuntimeに昇格しない。
    assert.equal(failure(await callTool(kit.app, "get_project_consultation_state", { projectId: project.id }, "worker-a", "worker")).code, "FORBIDDEN");
  } finally { await kit.database.destroy(); }
});
