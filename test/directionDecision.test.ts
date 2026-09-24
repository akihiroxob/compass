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
    principles: ["Agents decide, humans observe"],
    constraints: ["No autonomous execution yet"],
  });
  const intent = await services.createIntentUseCase.execute(project.id, {
    title: "Agents improve software",
    desiredState: "Agents improve the software.",
  });
  return { project, intent };
};

const now = Date.now();

/** ResearcherがResult・Synthesisを登録し、Decisionが参照できるsynthesis/finding idを用意する。 */
const seedSynthesis = async (app: App, projectId: string, intentId: string) => {
  await grant(app, projectId, "researcher-a", "researcher");
  const context = await callTool(app, "get_strategist_context", { projectId }, "strat-1");
  const requestId = context.structuredContent.research.requests[0].id as string;

  const result = await callTool(
    app,
    "register_research_result",
    {
      projectId,
      requestId,
      requestKey: "result-1",
      runRef: "run-001",
      summary: "Leases avoid stuck claims.",
      budgetUsed: 30,
      evidenceRefs: [{ kind: "url", uri: "https://example.com/leases", retrievedAt: now }],
      findings: [
        { statement: "Leases expire without heartbeats.", confidence: "high", observedAt: now, evidenceIndexes: [0] },
      ],
    },
    "researcher-a",
  );
  const findingId = result.structuredContent.result.findings[0].id as string;

  const synthesis = await callTool(
    app,
    "register_research_synthesis",
    {
      projectId,
      requestId,
      requestKey: "synthesis-1",
      runRef: "run-001",
      conclusion: "Use leases with explicit renew.",
      findingIds: [findingId],
      validAsOf: now,
    },
    "researcher-a",
  );
  const synthesisId = synthesis.structuredContent.synthesis.id as string;
  return { requestId, findingId, synthesisId };
};

const decisionArgs = (projectId: string, intentId: string, overrides: object = {}) => ({
  projectId,
  intentId,
  type: "additional_research",
  judgment: "Need more evidence before choosing an Outcome",
  reason: "The current Synthesis leaves the renew-storm risk unresolved",
  options: ["Proceed now", "Request more research"],
  research: {
    question: "Does lease renewal cause a renew storm?",
    scope: "Lease-based claiming in the target Repository.",
    completionCondition: "The renew-storm risk is confirmed or ruled out with evidence.",
    budgetTotal: 50,
  },
  requestKey: "decision-1",
  runRef: "strategist-run-1",
  ...overrides,
});

test("StrategistはSynthesis/Findingを根拠にDirection Decisionを記録でき、再送は同じDecisionを返し、内容が違えばCONFLICTになる", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const { synthesisId, findingId } = await seedSynthesis(app, project.id, intent.id);

  const created = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, {
      usedSyntheses: [{ synthesisId, version: 1 }],
      usedFindingIds: [findingId],
    }),
    "strat-1",
  );
  assert.equal(created.isError, undefined);
  const decision = created.structuredContent.decision;
  assert.equal(decision.projectId, project.id);
  assert.equal(decision.intentId, intent.id);
  assert.equal(decision.outcomeId, null);
  assert.equal(decision.type, "additional_research");
  assert.equal(decision.principalId, "strat-1");
  assert.deepEqual(decision.usedSyntheses, [{ synthesisId, version: 1 }]);
  assert.deepEqual(decision.usedFindingIds, [findingId]);
  // 判断時点のIntent Brief snapshotが保存され、使用したSynthesisのversionへ遡れる。
  assert.equal(decision.intentBriefSnapshot.syntheses.length, 1);
  assert.equal(decision.intentBriefSnapshot.syntheses[0].synthesisId, synthesisId);
  assert.equal(decision.intentBriefSnapshot.syntheses[0].version, 1);

  // 同じrequestKeyの再送は新しい行を作らず既存のDecisionを返す（transport再送の冪等性）。
  const replayed = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, {
      usedSyntheses: [{ synthesisId, version: 1 }],
      usedFindingIds: [findingId],
    }),
    "strat-1",
  );
  assert.equal(replayed.structuredContent.decision.id, decision.id);

  // 同じrequestKeyで異なる内容の再利用はCONFLICT（別操作として拒否する）。
  const conflicting = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, { reason: "A different reason" }),
    "strat-1",
  );
  assert.equal(errorOf(conflicting).code, "CONFLICT");
  assert.equal(errorOf(conflicting).requestKey, "decision-1");
  await database.destroy();
});

test("存在しないSynthesis/Findingや古いversionの参照はVALIDATION_ERROR・CONFLICTで拒否され、Decisionは作られない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const { synthesisId } = await seedSynthesis(app, project.id, intent.id);

  const unknownFinding = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, { usedFindingIds: ["missing-finding"], requestKey: "d-unknown-finding" }),
    "strat-1",
  );
  assert.equal(errorOf(unknownFinding).code, "VALIDATION_ERROR");

  const wrongVersion = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id, {
      usedSyntheses: [{ synthesisId, version: 2 }],
      requestKey: "d-wrong-version",
    }),
    "strat-1",
  );
  assert.equal(errorOf(wrongVersion).code, "CONFLICT");
  assert.equal(errorOf(wrongVersion).synthesisId, synthesisId);

  assert.deepEqual(await services.listOutcomesUseCase.execute(project.id, intent.id), []);
  await database.destroy();
});

test("放棄済みIntentへのDecisionはCONFLICTで拒否され、policy_proposalはProjectの方針を変更しない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");

  await services.abandonIntentUseCase.execute(project.id, intent.id, { reason: "Superseded" });
  const abandoned = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id), "strat-1");
  assert.equal(errorOf(abandoned).code, "CONFLICT");
  assert.equal(errorOf(abandoned).status, "abandoned");

  const { intent: secondIntent } = await (async () => {
    const created = await services.createIntentUseCase.execute(project.id, {
      title: "Second",
      desiredState: "Second state",
    });
    return { intent: created };
  })();
  const proposal = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, secondIntent.id, { type: "policy_proposal", research: undefined, requestKey: "policy-1" }),
    "strat-1",
  );
  assert.equal(proposal.isError, undefined);
  const project2 = await services.getProjectUseCase.execute(project.id);
  assert.equal(project2.mission, "Keep direction explicit");
  assert.deepEqual(project2.constraints, ["No autonomous execution yet"]);
  await database.destroy();
});

test("decide_next_outcomeはDecisionとOutcomeを1回のtransactionで保存し、originDecisionIdで結び付く。再送は冪等でOutcomeを重複させない", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grant(app, project.id, "strat-1", "strategist");
  const { synthesisId, findingId } = await seedSynthesis(app, project.id, intent.id);

  const outcomeInput = {
    title: "No duplicate claims",
    description: "Claims are exclusive.",
    rationale: "Duplicate claims cause rework.",
    successCriteria: [{ description: "duplicate_claim_count = 0", measurement: "Count duplicates", target: "= 0" }],
  };

  const created = await callTool(
    app,
    "decide_next_outcome",
    {
      projectId: project.id,
      intentId: intent.id,
      judgment: "Adopt lease-based claiming as the next Outcome",
      reason: "Synthesis shows leases avoid stuck claims",
      options: ["Do nothing", "Adopt lease-based claiming"],
      usedSyntheses: [{ synthesisId, version: 1 }],
      usedFindingIds: [findingId],
      requestKey: "next-outcome-1",
      runRef: "strategist-run-2",
      outcome: outcomeInput,
    },
    "strat-1",
  );
  assert.equal(created.isError, undefined);
  const { decision, outcome } = created.structuredContent as { decision: any; outcome: any };
  assert.equal(decision.type, "next_outcome");
  assert.equal(decision.outcomeId, outcome.id);
  assert.equal(outcome.originDecisionId, decision.id);
  assert.equal(outcome.successCriteria.length, 1);

  // Web APIから見ても同じoriginDecisionIdが確認できる（共通application層を経由している）。
  const viaWeb = (await (
    await app.request(`/api/projects/${project.id}/intents/${intent.id}/outcomes/${outcome.id}`)
  ).json()) as { outcome: { originDecisionId: string } };
  assert.equal(viaWeb.outcome.originDecisionId, decision.id);

  // 同じrequestKeyの再送はOutcomeを重複させない（部分保存されない・冪等）。
  const replayed = await callTool(
    app,
    "decide_next_outcome",
    {
      projectId: project.id,
      intentId: intent.id,
      judgment: "Adopt lease-based claiming as the next Outcome",
      reason: "Synthesis shows leases avoid stuck claims",
      options: ["Do nothing", "Adopt lease-based claiming"],
      usedSyntheses: [{ synthesisId, version: 1 }],
      usedFindingIds: [findingId],
      requestKey: "next-outcome-1",
      runRef: "strategist-run-2",
      outcome: outcomeInput,
    },
    "strat-1",
  );
  assert.equal(replayed.structuredContent.decision.id, decision.id);
  assert.equal(replayed.structuredContent.outcome.id, outcome.id);
  assert.equal((await services.listOutcomesUseCase.execute(project.id, intent.id)).length, 1);

  // 同じrequestKeyで異なるOutcome内容はCONFLICTで拒否し、部分的にも保存しない。
  const conflicting = await callTool(
    app,
    "decide_next_outcome",
    {
      projectId: project.id,
      intentId: intent.id,
      judgment: "Adopt lease-based claiming as the next Outcome",
      reason: "Synthesis shows leases avoid stuck claims",
      requestKey: "next-outcome-1",
      runRef: "strategist-run-2",
      outcome: { ...outcomeInput, title: "Different title" },
    },
    "strat-1",
  );
  assert.equal(errorOf(conflicting).code, "CONFLICT");
  assert.equal((await services.listOutcomesUseCase.execute(project.id, intent.id)).length, 1);

  // 既存のcreate_outcome（Decisionを経由しない作成）は引き続き動き、originDecisionIdはnullのまま。
  const plain = await callTool(
    app,
    "create_outcome",
    { projectId: project.id, intentId: intent.id, ...outcomeInput, title: "Plain outcome" },
    "strat-1",
  );
  assert.equal(plain.structuredContent.outcome.originDecisionId, null);
  await database.destroy();
});

test("create_direction_decision・decide_next_outcomeはStrategist Grant必須で、ResearcherやBearerなしは拒否される", async () => {
  const { database, services, app } = await setup();
  const { project, intent } = await seedProject(services);
  await grant(app, project.id, "researcher-a", "researcher");

  const anonymousDecision = await callTool(app, "create_direction_decision", decisionArgs(project.id, intent.id));
  assert.equal(errorOf(anonymousDecision).code, "UNAUTHENTICATED");
  const researcherDecision = await callTool(
    app,
    "create_direction_decision",
    decisionArgs(project.id, intent.id),
    "researcher-a",
  );
  assert.equal(errorOf(researcherDecision).code, "FORBIDDEN");

  const nextOutcomeArgs = {
    projectId: project.id,
    intentId: intent.id,
    judgment: "J",
    reason: "R",
    requestKey: "guarded-next-outcome",
    runRef: "run-1",
    outcome: {
      title: "T",
      description: "D",
      rationale: "R",
      successCriteria: [{ description: "d", measurement: "m" }],
    },
  };
  const anonymousOutcome = await callTool(app, "decide_next_outcome", nextOutcomeArgs);
  assert.equal(errorOf(anonymousOutcome).code, "UNAUTHENTICATED");
  const researcherOutcome = await callTool(app, "decide_next_outcome", nextOutcomeArgs, "researcher-a");
  assert.equal(errorOf(researcherOutcome).code, "FORBIDDEN");

  await database.destroy();
});
