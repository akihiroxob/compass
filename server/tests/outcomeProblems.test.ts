import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

const start = 1_800_000_000_000;
const outcomeInput = {
  intentVersion: 1,
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [{ description: "duplicates = 0", measurement: "Count duplicates" }],
};

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, services: createApplicationServices(database, undefined, () => start) };
};
type Services = Awaited<ReturnType<typeof setup>>["services"];

const seedWorkspace = async (services: Services, name: string) => {
  const project = await services.createProjectUseCase.execute({ name, mission: "Keep direction explicit" });
  const intent = await services.createIntentUseCase.execute(project.workspaceId, { title: "Intent", desiredState: "State" });
  const request = await services.createResearchRequestUseCase.execute(project.workspaceId, {
    requestKey: "r1",
    kind: "decision",
    question: "Which strategy?",
    scope: "claims",
    completionCondition: "evidence exists",
    budgetTotal: 100,
    originIntentId: intent.id,
  });
  const result = await services.registerResearchResultUseCase.execute(project.workspaceId, request.id, {
    requestKey: "res1",
    principalId: "researcher-a",
    runRef: "run-1",
    summary: "s",
    budgetUsed: 10,
    evidenceRefs: [{ kind: "url", uri: "https://example.com/a", retrievedAt: start }],
    findings: [{ statement: "Users drop off at step 2.", confidence: "medium", observedAt: start, evidenceIndexes: [0] }],
    unknowns: [],
    options: [],
    risks: [],
  });
  const findingIds = result.findings.map(({ id }) => id);
  const v1 = await services.registerResearchSynthesisUseCase.execute(project.workspaceId, request.id, {
    requestKey: "s1",
    principalId: "researcher-a",
    runRef: "run-1",
    conclusion: "v1",
    findingIds,
    risks: [],
    options: [],
    unknowns: [],
    validAsOf: start,
  });
  return { project, intent, request, findingId: findingIds[0]!, v1 };
};

type Rejection = { code?: string; details?: Record<string, unknown>; issues?: { path: string }[] };
const rejectsWith = (code: string, check: (error: Rejection) => void = () => {}) => (error: unknown) => {
  assert.equal((error as Rejection).code, code);
  check(error as Rejection);
  return true;
};

test("課題は観測と原因の仮説を別に保存し、根拠を参照先から解決して返す", async () => {
  const { database, services } = await setup();
  const { project, intent, findingId, v1 } = await seedWorkspace(services, "A");
  const created = await services.createOutcomeUseCase.execute(project.workspaceId, intent.id, {
    ...outcomeInput,
    problems: [
      { statement: "離脱が多い", evidenceStatus: "insufficient", causeHypothesis: "導線が分かりにくい" },
      {
        statement: "登録が進まない",
        evidenceStatus: "observed",
        observation: "step 2で離脱",
        solutionHypothesis: "入力を減らす",
        evidence: [{ kind: "research_finding", id: findingId }, { kind: "research_synthesis", id: v1.id }],
      },
    ],
  });
  assert.equal(created.revision, 1);
  assert.deepEqual(created.problems.map((p) => [p.position, p.evidenceStatus]), [[0, "insufficient"], [1, "observed"]]);
  assert.equal(created.problems[0]!.observation, null);
  assert.equal(created.problems[0]!.causeHypothesis, "導線が分かりにくい");
  assert.equal(created.problems[1]!.evidence[0]!.summary, "Users drop off at step 2.");
  assert.equal(created.problems[1]!.evidence[1]!.superseded, false);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.workspaceId, intent.id, created.id), created);
  await database.destroy();
});

test("観測済み・反証は観測と根拠が必須で、課題の更新はexpectedRevisionを要求し古い版を拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent, findingId } = await seedWorkspace(services, "A");
  const outcome = await services.createOutcomeUseCase.execute(project.workspaceId, intent.id, outcomeInput);
  await assert.rejects(
    services.createOutcomeUseCase.execute(project.workspaceId, intent.id, {
      ...outcomeInput,
      problems: [{ statement: "x", evidenceStatus: "observed" }],
    }),
    rejectsWith("VALIDATION_ERROR"),
  );
  const problems = [{ statement: "x", evidenceStatus: "refuted", observation: "o", evidence: [{ kind: "research_finding", id: findingId }] }];
  await assert.rejects(
    services.updateOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id, { problems }),
    rejectsWith("VALIDATION_ERROR", (e) => assert.ok(e.issues?.some((i) => i.path === "expectedRevision"))),
  );
  const updated = await services.updateOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id, {
    problems,
    expectedRevision: 1,
  });
  assert.equal(updated.revision, 2);
  assert.equal(updated.successCriteria.length, outcome.successCriteria.length);
  await assert.rejects(
    services.updateOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id, { problems: [], expectedRevision: 1 }),
    rejectsWith("CONFLICT"),
  );
  assert.equal((await services.getOutcomeUseCase.execute(project.workspaceId, intent.id, outcome.id)).problems.length, 1);
  await database.destroy();
});

test("別Workspaceの根拠と、新規に古い版のSynthesisを関連付けることは拒否される", async () => {
  const { database, services } = await setup();
  const a = await seedWorkspace(services, "A");
  const b = await seedWorkspace(services, "B");
  await assert.rejects(
    services.createOutcomeUseCase.execute(a.project.workspaceId, a.intent.id, {
      ...outcomeInput,
      problems: [{ statement: "x", evidenceStatus: "observed", observation: "o", evidence: [{ kind: "research_finding", id: b.findingId }] }],
    }),
    rejectsWith("VALIDATION_ERROR"),
  );
  await services.registerResearchSynthesisUseCase.execute(a.project.workspaceId, a.request.id, {
    requestKey: "s2",
    principalId: "researcher-a",
    runRef: "run-1",
    conclusion: "v2",
    findingIds: [a.findingId],
    supersedesId: a.v1.id,
    risks: [],
    options: [],
    unknowns: [],
    validAsOf: start,
  });
  await assert.rejects(
    services.createOutcomeUseCase.execute(a.project.workspaceId, a.intent.id, {
      ...outcomeInput,
      problems: [{ statement: "x", evidenceStatus: "observed", observation: "o", evidence: [{ kind: "research_synthesis", id: a.v1.id }] }],
    }),
    rejectsWith("CONFLICT"),
  );
  await database.destroy();
});
