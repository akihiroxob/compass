import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: createApp(services) };
};

type Services = Awaited<ReturnType<typeof setup>>["services"];

const send = async (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const rpc = async (app: App, method: string, params: object, principal?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const callTool = async (app: App, name: string, args: object, principal?: string): Promise<ToolResult> =>
  (await rpc(app, "tools/call", { name, arguments: args }, principal)).result;

const grantRole = (app: App, projectId: string, principalId: string, role = "researcher") =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

const seedProject = async (services: Services, name = "Compass") => {
  const project = await services.createProjectUseCase.execute({
    name,
    mission: "Keep direction explicit",
    principles: ["Agents decide, humans observe"],
    constraints: ["No autonomous execution yet"],
  });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: "Agents improve software",
    desiredState: "Agents improve the software.",
  });
  return { project, intent };
};

const createRequest = (services: Services, projectId: string, intentId: string, overrides: object = {}) =>
  services.createResearchRequestUseCase.execute(projectId, {
    requestKey: "request-1",
    kind: "decision",
    originIntentId: intentId,
    question: "Which claim strategy avoids duplicate work?",
    scope: "Task claiming",
    completionCondition: "A recommendation with evidence exists",
    budgetTotal: 100,
    ...overrides,
  });

const now = Date.now();

const resultArgs = (projectId: string, requestId: string, overrides: object = {}) => ({
  projectId,
  requestId,
  requestKey: "result-1",
  runRef: "run-001",
  summary: "Leases avoid stuck claims.",
  budgetUsed: 30,
  evidenceRefs: [
    { kind: "url", uri: "https://example.com/leases", retrievedAt: now, versionHash: "sha256:abc" },
    { kind: "repository_file", uri: "docs/claims.md", retrievedAt: now },
  ],
  findings: [
    { statement: "Leases expire without heartbeats.", confidence: "high", observedAt: now, evidenceIndexes: [0, 1] },
    { statement: "Locks can stall workers.", confidence: "medium", observedAt: now, evidenceIndexes: [1] },
  ],
  unknowns: ["Behaviour under clock skew"],
  options: ["Lease with renew"],
  risks: ["Renew storms"],
  ...overrides,
});

const synthesisArgs = (projectId: string, requestId: string, findingIds: string[], overrides: object = {}) => ({
  projectId,
  requestId,
  requestKey: "synthesis-1",
  runRef: "run-001",
  conclusion: "Use leases with explicit renew.",
  findingIds,
  validAsOf: now,
  ...overrides,
});

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true);
  // ConflictErrorのdetailsはerror直下へ展開される（createMcpServerのexecute）。
  return result.structuredContent.error as { code: string; message: string } & Record<string, string>;
};

test("Researcherは Bearer だけで Context を取得し、Result・Synthesis 登録と確定まで Human の操作なしで進められる", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  const request = await createRequest(services, project.id, intent.id);
  assert.equal((await grantRole(app, project.id, "researcher-a")).status, 201);

  const context = (await callTool(app, "get_researcher_context", { projectId: project.id, requestId: request.id }, "researcher-a"))
    .structuredContent;
  assert.equal(context.principalId, "researcher-a");
  assert.equal(context.role, "researcher");
  assert.equal(context.project.id, project.id);
  assert.deepEqual(context.project.principles, ["Agents decide, humans observe"]);
  assert.deepEqual(context.project.constraints, ["No autonomous execution yet"]);
  assert.equal(context.originIntent.id, intent.id);
  assert.equal(context.request.question, "Which claim strategy avoids duplicate work?");
  assert.equal(context.request.status, "requested");
  assert.deepEqual(context.budget, { total: 100, used: 0, remaining: 100 });
  assert.deepEqual([context.results, context.syntheses, context.relatedFindings, context.relatedEvidenceRefs], [[], [], [], []]);
  assert.deepEqual(context.unavailable, ["evaluation"]);

  // principalIdをtool入力へ混ぜても、来歴はBearerのPrincipalになる。
  const registered = await callTool(
    app,
    "register_research_result",
    { ...resultArgs(project.id, request.id), principalId: "impostor" },
    "researcher-a",
  );
  assert.equal(registered.isError, undefined);
  const result = registered.structuredContent.result;
  assert.equal(result.principalId, "researcher-a");
  assert.equal(result.runRef, "run-001");
  assert.deepEqual(result.findings.map((finding: any) => [finding.principalId, finding.runRef]), [
    ["researcher-a", "run-001"],
    ["researcher-a", "run-001"],
  ]);

  const findingIds = result.findings.map((finding: any) => finding.id);
  const synthesized = await callTool(app, "register_research_synthesis", synthesisArgs(project.id, request.id, findingIds), "researcher-a");
  assert.equal(synthesized.isError, undefined);
  assert.equal(synthesized.structuredContent.synthesis.principalId, "researcher-a");
  assert.equal(synthesized.structuredContent.synthesis.runRef, "run-001");
  assert.equal(synthesized.structuredContent.synthesis.version, 1);

  const completed = await callTool(
    app,
    "complete_research_request",
    { projectId: project.id, requestId: request.id, conclusion: "completed" },
    "researcher-a",
  );
  assert.equal(completed.isError, undefined);
  assert.equal(completed.structuredContent.request.status, "completed");

  // 再開したRunは、登録済みの結果を Context で確認できる。
  const after = (await callTool(app, "get_researcher_context", { projectId: project.id, requestId: request.id }, "researcher-a"))
    .structuredContent;
  assert.equal(after.request.status, "completed");
  assert.deepEqual(after.budget, { total: 100, used: 30, remaining: 70 });
  assert.equal(after.results.length, 1);
  assert.equal(after.results[0].evidenceRefs.length, 2);
  assert.equal(after.syntheses.length, 1);

  // 終了後の追記は拒否される。
  const late = errorOf(
    await callTool(app, "register_research_result", resultArgs(project.id, request.id, { requestKey: "result-2" }), "researcher-a"),
  );
  assert.equal(late.code, "CONFLICT");
  assert.equal(late.status, "completed");
  await database.destroy();
});

test("Contextは同じ発端の他RequestのFindingとEvidence参照だけを返し、自身・別Intent・別Projectのものを含めない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");

  const earlier = await createRequest(services, project.id, intent.id, { requestKey: "earlier" });
  const earlierResult = (await callTool(app, "register_research_result", resultArgs(project.id, earlier.id), "researcher-a"))
    .structuredContent.result;
  const current = await createRequest(services, project.id, intent.id, { requestKey: "current" });
  const own = (await callTool(app, "register_research_result", resultArgs(project.id, current.id, {
    findings: [{ statement: "Own finding", confidence: "low", observedAt: now, evidenceIndexes: [0] }],
  }), "researcher-a")).structuredContent.result;

  // 別Intentと別ProjectのFindingは関連しない。
  await services.abandonIntentUseCase.execute(project.id, intent.id, {});
  const otherIntent = await services.createIntentUseCase.execute(project.id, { title: "Other", desiredState: "Other state" });
  const otherIntentRequest = await createRequest(services, project.id, otherIntent.id, { requestKey: "other-intent" });
  await callTool(app, "register_research_result", resultArgs(project.id, otherIntentRequest.id), "researcher-a");
  const otherProject = await seedProject(services, "Other Project");
  const otherProjectRequest = await createRequest(services, otherProject.project.id, otherProject.intent.id, { requestKey: "other-project" });
  await grantRole(app, otherProject.project.id, "researcher-a");
  await callTool(app, "register_research_result", resultArgs(otherProject.project.id, otherProjectRequest.id), "researcher-a");

  const context = (await callTool(app, "get_researcher_context", { projectId: project.id, requestId: current.id }, "researcher-a"))
    .structuredContent;
  const earlierIds = earlierResult.findings.map((finding: any) => finding.id).sort();
  assert.deepEqual(context.relatedFindings.map((finding: any) => finding.id).sort(), earlierIds);
  assert.ok(!context.relatedFindings.some((finding: any) => finding.requestId !== earlier.id));
  assert.deepEqual(context.results.map((item: any) => item.id), [own.id]);
  // 引用されたEvidence参照だけを返す（Finding 2件が両Evidenceを引用する）。
  assert.deepEqual(
    context.relatedEvidenceRefs.map((evidence: any) => evidence.id).sort(),
    earlierResult.evidenceRefs.map((evidence: any) => evidence.id).sort(),
  );
  assert.ok(context.relatedEvidenceRefs.every((evidence: any) => evidence.resultId === earlierResult.id));
  await database.destroy();
});

test("Requestはcompleted / insufficient / not_neededのいずれかで確定でき、停止理由と必須条件を検証する", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");
  const close = (requestId: string, args: object) =>
    callTool(app, "complete_research_request", { projectId: project.id, requestId, ...args }, "researcher-a");

  const insufficient = await createRequest(services, project.id, intent.id, { requestKey: "a" });
  assert.equal(errorOf(await close(insufficient.id, { conclusion: "insufficient" })).code, "VALIDATION_ERROR");
  const closedInsufficient = await close(insufficient.id, { conclusion: "insufficient", stopReason: "Budget exhausted" });
  assert.equal(closedInsufficient.structuredContent.request.status, "insufficient");
  assert.equal(closedInsufficient.structuredContent.request.stopReason, "Budget exhausted");

  const notNeeded = await createRequest(services, project.id, intent.id, { requestKey: "b" });
  const closedNotNeeded = await close(notNeeded.id, { conclusion: "not_needed", stopReason: "Existing knowledge suffices" });
  assert.equal(closedNotNeeded.structuredContent.request.status, "not_needed");

  const incomplete = await createRequest(services, project.id, intent.id, { requestKey: "c" });
  assert.equal(errorOf(await close(incomplete.id, { conclusion: "completed" })).code, "CONFLICT");
  // cancelledはResearcherが確定できる状態ではない。
  assert.equal(errorOf(await close(incomplete.id, { conclusion: "cancelled", stopReason: "x" })).code, "VALIDATION_ERROR");
  assert.equal((await services.getResearchRequestUseCase.execute(project.id, incomplete.id)).request.status, "requested");
  await database.destroy();
});

test("同じrequestKeyの再送は重複せず、内容を変えた再利用はCONFLICTになる", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");
  const request = await createRequest(services, project.id, intent.id);
  const first = await callTool(app, "register_research_result", resultArgs(project.id, request.id), "researcher-a");
  const replay = await callTool(app, "register_research_result", resultArgs(project.id, request.id), "researcher-a");
  assert.equal(replay.structuredContent.result.id, first.structuredContent.result.id);
  const changed = errorOf(
    await callTool(app, "register_research_result", resultArgs(project.id, request.id, { summary: "Different" }), "researcher-a"),
  );
  assert.equal(changed.code, "CONFLICT");
  const detail = await services.getResearchRequestUseCase.execute(project.id, request.id);
  assert.equal(detail.results.length, 1);
  assert.equal(detail.request.budgetUsed, 30);
  await database.destroy();
});

test("archivedのProjectへResultを登録できない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");
  const request = await createRequest(services, project.id, intent.id);
  await services.archiveProjectUseCase.execute(project.id, { reason: "Archived for test" });
  const rejected = errorOf(await callTool(app, "register_research_result", resultArgs(project.id, request.id), "researcher-a"));
  assert.equal(rejected.code, "CONFLICT");
  assert.equal(rejected.projectStatus, "archived");
  assert.equal((await services.getResearchRequestUseCase.execute(project.id, request.id)).results.length, 0);
  await database.destroy();
});

test("list_research_requestsはProjectのRequestを状態で絞って返す", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");
  const open = await createRequest(services, project.id, intent.id, { requestKey: "open" });
  const closed = await createRequest(services, project.id, intent.id, { requestKey: "closed" });
  await callTool(app, "complete_research_request", { projectId: project.id, requestId: closed.id, conclusion: "not_needed", stopReason: "Known" }, "researcher-a");
  const listed = await callTool(app, "list_research_requests", { projectId: project.id, status: "requested" }, "researcher-a");
  assert.deepEqual(listed.structuredContent.requests.map((item: any) => item.id), [open.id]);
  const all = await callTool(app, "list_research_requests", { projectId: project.id }, "researcher-a");
  assert.equal(all.structuredContent.requests.length, 2);
  await database.destroy();
});

test("Researcher toolはBearerなし・Grantなし・別Project・取消済み・Role自己申告を拒否し、何も保存しない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  const other = await seedProject(services, "Other");
  const request = await createRequest(services, project.id, intent.id);
  const otherRequest = await createRequest(services, other.project.id, other.intent.id);
  const calls = (projectId: string, requestId: string): [string, object][] => [
    ["get_researcher_context", { projectId, requestId }],
    ["list_research_requests", { projectId }],
    ["register_research_result", resultArgs(projectId, requestId)],
    ["register_research_synthesis", synthesisArgs(projectId, requestId, ["x"])],
    ["complete_research_request", { projectId, requestId, conclusion: "not_needed", stopReason: "x" }],
  ];

  for (const [name, args] of calls(project.id, request.id)) {
    assert.equal(errorOf(await callTool(app, name, args)).code, "UNAUTHENTICATED", `${name} without Bearer`);
    assert.equal(errorOf(await callTool(app, name, args, "nobody")).code, "FORBIDDEN", `${name} without Grant`);
    // Role・principalの自己申告は認可に使われない。
    assert.equal(
      errorOf(await callTool(app, name, { ...args, role: "researcher", principalId: "researcher-a" }, "nobody")).code,
      "FORBIDDEN",
      `${name} self-declared`,
    );
  }

  // Strategist Grantだけでは使えない。
  await grantRole(app, project.id, "strat-1", "strategist");
  for (const [name, args] of calls(project.id, request.id)) {
    assert.equal(errorOf(await callTool(app, name, args, "strat-1")).code, "FORBIDDEN", `${name} as strategist`);
  }

  // 別ProjectのGrantでは使えず、GrantのあるProjectからでもProject外のRequestは見えない。
  await grantRole(app, other.project.id, "researcher-b");
  for (const [name, args] of calls(project.id, request.id)) {
    assert.equal(errorOf(await callTool(app, name, args, "researcher-b")).code, "FORBIDDEN", `${name} other project`);
  }
  for (const [name, args] of calls(other.project.id, request.id).filter(([name]) => name !== "list_research_requests")) {
    assert.equal(errorOf(await callTool(app, name, args, "researcher-b")).code, "NOT_FOUND", `${name} foreign request`);
  }

  // 取消後は次の呼び出しから拒否する。
  await grantRole(app, project.id, "researcher-a");
  assert.equal((await callTool(app, "get_researcher_context", { projectId: project.id, requestId: request.id }, "researcher-a")).isError, undefined);
  assert.equal((await send(app, "DELETE", `/api/projects/${project.id}/grants/researcher/researcher-a`)).status, 200);
  for (const [name, args] of calls(project.id, request.id)) {
    assert.equal(errorOf(await callTool(app, name, args, "researcher-a")).code, "FORBIDDEN", `${name} revoked`);
  }

  for (const target of [request, otherRequest]) {
    const detail = await services.getResearchRequestUseCase.execute(target.projectId, target.id);
    assert.equal(detail.results.length, 0);
    assert.equal(detail.syntheses.length, 0);
    assert.equal(detail.request.status, "requested");
  }
  await database.destroy();
});

test("Researcherは Outcome・Project基盤設定・Intent を変更できない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grantRole(app, project.id, "researcher-a");
  const rejected = async (name: string, args: object) => {
    const error = errorOf(await callTool(app, name, args, "researcher-a"));
    assert.equal(error.code, "FORBIDDEN", name);
  };

  await rejected("create_outcome", {
    projectId: project.id,
    intentId: intent.id,
    title: "T",
    description: "D",
    rationale: "R",
    successCriteria: [{ description: "d", measurement: "m" }],
  });
  await rejected("update_project", { projectId: project.id, mission: "Loosen everything", constraints: [] });
  await rejected("create_intent", { projectId: project.id, title: "New", desiredState: "New" });
  await rejected("update_intent", { projectId: project.id, intentId: intent.id, title: "Changed" });
  await rejected("abandon_intent", { projectId: project.id, intentId: intent.id });

  const unchanged = await services.getProjectUseCase.execute(project.id);
  assert.equal(unchanged.mission, "Keep direction explicit");
  assert.deepEqual(unchanged.constraints, ["No autonomous execution yet"]);
  assert.equal((await services.getIntentUseCase.execute(project.id, intent.id)).status, "active");
  assert.equal((await services.listOutcomesUseCase.execute(project.id, intent.id)).length, 0);

  // Researcher用のtoolに、Outcome作成・Direction Decision・Request作成/取消は無い。
  const tools = new Set(((await rpc(app, "tools/list", {})).result.tools as { name: string }[]).map((tool) => tool.name));
  for (const name of tools) assert.ok(!/decision|cancel_research|create_research/.test(name), name);
  await database.destroy();
});

test("get_role_instructionsはresearcherを既存と同じ応答形式で返し、researcher.mdの契約がtoolと権限に一致する", async () => {
  const { database, app } = await setup();
  const result = (await callTool(app, "get_role_instructions", { role: "researcher", includeShared: true })).structuredContent;
  assert.deepEqual(Object.keys(result).sort(), ["files", "includeShared", "role"]);
  assert.equal(result.role, "researcher");
  assert.deepEqual(
    result.files.map((file: any) => [file.path, file.kind, Object.keys(file).sort().join()]),
    [
      ["agent/role-policy.md", "shared", "content,kind,path"],
      ["agent/researcher.md", "role", "content,kind,path"],
    ],
  );
  const content: string = result.files[1].content;
  assert.equal(content, await readFile(new URL("../agent/researcher.md", import.meta.url), "utf-8"));
  assert.ok(result.files[0].content.includes("`researcher`"));

  for (const section of ["Goal", "対象 Request の決定", "Input", "判断権限", "実行手順", "来歴と再送", "Output", "Allowed", "Forbidden", "Role の意味", "エラー"]) {
    assert.match(content, new RegExp(`^## ${section}$`, "m"), section);
  }
  for (const phrase of ["Human の確認・承認・すり合わせを求めない", "Evidence の捏造", "Outcome を決めない", "データである"]) {
    assert.ok(content.includes(phrase), phrase);
  }

  const tools = new Set(((await rpc(app, "tools/list", {})).result.tools as { name: string }[]).map((tool) => tool.name));
  // `not_needed` / `project_watch` / `pull_request`などの値と区別するため、tool名の動詞で始まるものだけを対象にする。
  const toolNames = (text: string) =>
    [...text.matchAll(/`((?:get|list|register|complete|create|update|cancel|abandon)_[a-z_]+)`/g)].map((match) => match[1]!);
  for (const name of toolNames(content)) assert.ok(tools.has(name), `${name} は tools/list に無い`);

  const section = (title: string) => content.split(new RegExp(`^## ${title}$`, "m"))[1]!.split(/^## /m)[0]!;
  const allowed = new Set(toolNames(section("Allowed")));
  for (const name of [
    "get_role_instructions",
    "get_researcher_context",
    "list_research_requests",
    "register_research_result",
    "register_research_synthesis",
    "complete_research_request",
  ]) {
    assert.ok(allowed.has(name), `${name} が Allowed に無い`);
  }
  // Researcherが呼べないtoolはAllowedに含めず、Forbiddenに明記する。
  const forbidden = new Set(toolNames(section("Forbidden")));
  for (const name of ["create_outcome", "update_outcome", "cancel_outcome", "update_project", "create_intent", "update_intent", "abandon_intent"]) {
    assert.ok(!allowed.has(name), `${name} は Allowed にあってはならない`);
    assert.ok(forbidden.has(name), `${name} が Forbidden に無い`);
  }
  await database.destroy();
});
