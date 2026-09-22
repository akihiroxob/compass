import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Services = ReturnType<typeof createApplicationServices>;

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  return { database, services, app: createApp(services) };
};

const send = (app: App, method: string, path: string, body?: unknown) =>
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

const errorOf = (result: ToolResult) => {
  assert.equal(result.isError, true);
  return result.structuredContent.error as { code: string; message: string } & Record<string, string>;
};

const grant = (app: App, projectId: string, principalId: string, role: string) =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

const seedProject = async (services: Services) => {
  const project = await services.createProjectUseCase.execute({
    name: "Compass",
    mission: "Keep direction explicit",
    constraints: ["No autonomous execution yet", "Human owns Mission changes"],
    repositories: [{ name: "compass", url: "https://github.com/example/compass" }],
  });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: "Agents improve software",
    desiredState: "Agents improve the software.",
  });
  return { project, intent, repositoryId: project.repositories[0]!.id };
};

/** adr_candidateのDirection Decisionを1件作る（create_adr_handoff_requestが依頼できる状態を用意する）。 */
const seedAdrCandidateDecision = async (app: App, projectId: string, intentId: string) => {
  const decision = await callTool(
    app,
    "create_direction_decision",
    {
      projectId,
      intentId,
      type: "adr_candidate",
      judgment: "Adopt lease-based claiming",
      reason: "Avoids stuck claims without a heartbeat service",
      options: ["Do nothing", "Adopt lease-based claiming"],
      requestKey: "adr-decision-1",
      runRef: "strategist-run-1",
    },
    "strat-1",
  );
  assert.equal(decision.isError, undefined, JSON.stringify(decision));
  return decision.structuredContent.decision.id as string;
};

const handoffArgs = (
  projectId: string,
  decisionId: string,
  repositoryId: string,
  overrides: object = {},
) => ({
  projectId,
  decisionId,
  repositoryId,
  correlationId: "adr-thread-1",
  requestKey: "handoff-1",
  ...overrides,
});

test("adr_candidate DecisionとRepositoryから依頼payloadを生成でき、再送は冪等で内容が違えばCONFLICTになる", async () => {
  const { database, services, app } = await setup();
  const { project, intent, repositoryId } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const decisionId = await seedAdrCandidateDecision(app, project.id, intent.id);

  const created = await callTool(app, "create_adr_handoff_request", handoffArgs(project.id, decisionId, repositoryId), "strat-1");
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const request = created.structuredContent.request;
  assert.equal(request.decisionId, decisionId);
  assert.equal(request.repositoryId, repositoryId);
  assert.equal(request.correlationId, "adr-thread-1");
  assert.equal(request.payload.decisionId, decisionId);
  assert.equal(request.payload.intentId, intent.id);
  assert.equal(request.payload.repositoryId, repositoryId);
  assert.equal(request.payload.repositoryName, "compass");
  assert.equal(request.payload.repositoryUrl, "https://github.com/example/compass");
  assert.deepEqual(request.payload.constraints, ["No autonomous execution yet", "Human owns Mission changes"]);
  assert.ok(request.payload.expectedAdrContent.includes("Adopt lease-based claiming"));
  assert.ok(request.payload.expectedAdrContent.includes("Avoids stuck claims without a heartbeat service"));
  assert.ok(request.payload.expectedAdrContent.includes("Do nothing"));

  // 同じrequestKeyの再送は新しい行を作らず既存の行を返す（transport再送の冪等性）。
  const replayed = await callTool(app, "create_adr_handoff_request", handoffArgs(project.id, decisionId, repositoryId), "strat-1");
  assert.equal(replayed.structuredContent.request.id, request.id);

  // 同じrequestKeyで異なる内容（別correlationId）の再利用はCONFLICT。重複した依頼は作られない。
  const conflicting = await callTool(
    app,
    "create_adr_handoff_request",
    handoffArgs(project.id, decisionId, repositoryId, { correlationId: "different-thread" }),
    "strat-1",
  );
  assert.equal(errorOf(conflicting).code, "CONFLICT");
  assert.equal(errorOf(conflicting).requestKey, "handoff-1");
  await database.destroy();
});

test("存在しないDecision・adr_candidateでないDecision・未登録Repositoryへの依頼は拒否される", async () => {
  const { database, services, app } = await setup();
  const { project, intent, repositoryId } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");

  const missingDecision = await callTool(
    app,
    "create_adr_handoff_request",
    handoffArgs(project.id, "missing-decision", repositoryId, { requestKey: "h-missing-decision" }),
    "strat-1",
  );
  assert.equal(errorOf(missingDecision).code, "NOT_FOUND");

  const nonAdrDecision = await callTool(
    app,
    "create_direction_decision",
    {
      projectId: project.id,
      intentId: intent.id,
      type: "additional_research",
      judgment: "Need more evidence",
      reason: "Renew-storm risk unresolved",
      requestKey: "non-adr-decision",
      runRef: "run-1",
    },
    "strat-1",
  );
  const nonAdrDecisionId = nonAdrDecision.structuredContent.decision.id as string;
  const wrongType = await callTool(
    app,
    "create_adr_handoff_request",
    handoffArgs(project.id, nonAdrDecisionId, repositoryId, { requestKey: "h-wrong-type" }),
    "strat-1",
  );
  assert.equal(errorOf(wrongType).code, "CONFLICT");
  assert.equal(errorOf(wrongType).type, "additional_research");

  const decisionId = await seedAdrCandidateDecision(app, project.id, intent.id);
  const missingRepository = await callTool(
    app,
    "create_adr_handoff_request",
    handoffArgs(project.id, decisionId, "missing-repository", { requestKey: "h-missing-repo" }),
    "strat-1",
  );
  assert.equal(errorOf(missingRepository).code, "NOT_FOUND");
  await database.destroy();
});

test("record_adr_referenceは対応するhandoff requestが必須で、絶対path・path traversal・短縮SHA・不正URLをVALIDATION_ERRORで拒否する", async () => {
  const { database, services, app } = await setup();
  const { project, intent, repositoryId } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const decisionId = await seedAdrCandidateDecision(app, project.id, intent.id);

  const referenceArgs = (overrides: object = {}) => ({
    projectId: project.id,
    decisionId,
    repositoryId,
    path: "docs/adr/0001-lease-based-claiming.md",
    commitSha: "a".repeat(40),
    correlationId: "adr-thread-1",
    requestKey: "reference-1",
    ...overrides,
  });

  // 対応するcreate_adr_handoff_requestが先に無いと拒否される（依頼を経ていない参照は作れない）。
  const orphanReference = await callTool(app, "record_adr_reference", referenceArgs(), "strat-1");
  assert.equal(errorOf(orphanReference).code, "CONFLICT");

  await callTool(app, "create_adr_handoff_request", handoffArgs(project.id, decisionId, repositoryId), "strat-1");

  // 異なるcorrelationIdの参照は、対応する依頼が見つからず拒否される。
  const mismatchedCorrelation = await callTool(
    app,
    "record_adr_reference",
    referenceArgs({ correlationId: "different-thread", requestKey: "reference-mismatch" }),
    "strat-1",
  );
  assert.equal(errorOf(mismatchedCorrelation).code, "CONFLICT");

  for (const [label, overrides] of [
    ["absolute path", { path: "/etc/passwd", requestKey: "reference-absolute" }],
    ["path traversal", { path: "../../secret.md", requestKey: "reference-traversal" }],
    ["windows absolute path", { path: "C:\\adr\\0001.md", requestKey: "reference-windows" }],
    ["short commit sha", { commitSha: "abc1234", requestKey: "reference-short-sha" }],
    ["non-hex commit sha", { commitSha: "z".repeat(40), requestKey: "reference-nonhex-sha" }],
    ["invalid pull request url", { pullRequestUrl: "not-a-url", requestKey: "reference-bad-url" }],
  ] as const) {
    const rejected = await callTool(app, "record_adr_reference", referenceArgs(overrides), "strat-1");
    assert.equal(errorOf(rejected).code, "VALIDATION_ERROR", label);
  }

  const created = await callTool(
    app,
    "record_adr_reference",
    referenceArgs({ pullRequestUrl: "https://github.com/example/compass/pull/42" }),
    "strat-1",
  );
  assert.equal(created.isError, undefined, JSON.stringify(created));
  const reference = created.structuredContent.reference;
  assert.equal(reference.decisionId, decisionId);
  assert.equal(reference.repositoryId, repositoryId);
  assert.equal(reference.path, "docs/adr/0001-lease-based-claiming.md");
  assert.equal(reference.commitSha, "a".repeat(40));
  assert.equal(reference.pullRequestUrl, "https://github.com/example/compass/pull/42");

  // 同じrequestKeyの再送は冪等（新しい行を作らない）。
  const replayed = await callTool(
    app,
    "record_adr_reference",
    referenceArgs({ pullRequestUrl: "https://github.com/example/compass/pull/42" }),
    "strat-1",
  );
  assert.equal(replayed.structuredContent.reference.id, reference.id);

  // 同じrequestKeyで異なる内容（別commit）はCONFLICT。
  const conflicting = await callTool(
    app,
    "record_adr_reference",
    referenceArgs({ commitSha: "b".repeat(40) }),
    "strat-1",
  );
  assert.equal(errorOf(conflicting).code, "CONFLICT");

  // Project scopeでの参照（Human向け画面・監査用途）。
  const listed = await callTool(app, "list_adr_references", { projectId: project.id });
  assert.equal(listed.structuredContent.references.length, 1);
  assert.equal(listed.structuredContent.references[0].id, reference.id);
  await database.destroy();
});

test("update_projectでADR Handoff Request/Referenceが参照するRepositoryを外そうとするとCONFLICTになり、他の変更も含めて何も更新しない", async () => {
  const { database, services, app } = await setup();
  const { project, intent, repositoryId } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const decisionId = await seedAdrCandidateDecision(app, project.id, intent.id);
  await callTool(app, "create_adr_handoff_request", handoffArgs(project.id, decisionId, repositoryId), "strat-1");

  // update_projectの1 transactionでname変更とRepository削除をまとめて送るが、
  // Repository削除がADR Handoff Requestに参照されているため拒否され、name変更も巻き込まれて失われない。
  const response = await send(app, "PATCH", `/api/projects/${project.id}`, {
    name: "Renamed while trying to drop repository",
    repositories: [],
  });
  assert.equal(response.status, 409);
  const body = (await response.json()) as { error: { code: string; repositoryId: string; repositoryName: string } };
  assert.equal(body.error.code, "CONFLICT");
  assert.equal(body.error.repositoryId, repositoryId);
  assert.equal(body.error.repositoryName, "compass");

  const unchanged = await services.getProjectUseCase.execute(project.id);
  assert.equal(unchanged.name, "Compass");
  assert.equal(unchanged.repositories.length, 1);
  assert.equal(unchanged.repositories[0]?.id, repositoryId);
  await database.destroy();
});

test("create_adr_handoff_request・record_adr_referenceはStrategist Grant必須で、ResearcherやBearerなしは拒否される", async () => {
  const { database, services, app } = await setup();
  const { project, intent, repositoryId } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  await grant(app, project.id, "researcher-a", "researcher");
  const decisionId = await seedAdrCandidateDecision(app, project.id, intent.id);

  const anonymousHandoff = await callTool(app, "create_adr_handoff_request", handoffArgs(project.id, decisionId, repositoryId));
  assert.equal(errorOf(anonymousHandoff).code, "UNAUTHENTICATED");
  const researcherHandoff = await callTool(
    app,
    "create_adr_handoff_request",
    handoffArgs(project.id, decisionId, repositoryId),
    "researcher-a",
  );
  assert.equal(errorOf(researcherHandoff).code, "FORBIDDEN");

  const referenceArgs = {
    projectId: project.id,
    decisionId,
    repositoryId,
    path: "docs/adr/0001.md",
    commitSha: "a".repeat(40),
    correlationId: "adr-thread-1",
    requestKey: "reference-guarded",
  };
  const anonymousReference = await callTool(app, "record_adr_reference", referenceArgs);
  assert.equal(errorOf(anonymousReference).code, "UNAUTHENTICATED");
  const researcherReference = await callTool(app, "record_adr_reference", referenceArgs, "researcher-a");
  assert.equal(errorOf(researcherReference).code, "FORBIDDEN");
  await database.destroy();
});
