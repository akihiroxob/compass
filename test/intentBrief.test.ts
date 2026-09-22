import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const projectInput = { name: "Compass", mission: "Keep direction explicit" };
const intentInput = { title: "Agents improve software", desiredState: "Agents improve the software." };

const start = 1_800_000_000_000;

const requestInput = (intentId: string, overrides: Record<string, unknown> = {}) => ({
  requestKey: "request-1",
  kind: "decision",
  originIntentId: intentId,
  question: "Which claim strategy avoids duplicate work?",
  scope: "Task claiming in multi-agent coordination",
  completionCondition: "A recommendation with evidence exists",
  budgetTotal: 100,
  ...overrides,
});

const resultInput = (overrides: Record<string, unknown> = {}) => ({
  requestKey: "result-1",
  principalId: "researcher-a",
  runRef: "run-001",
  summary: "Leases avoid stuck claims.",
  budgetUsed: 10,
  evidenceRefs: [{ kind: "url", uri: "https://example.com/leases", retrievedAt: start }],
  findings: [
    { statement: "Leases expire without heartbeats.", confidence: "high", observedAt: start, evidenceIndexes: [0] },
  ],
  ...overrides,
});

const synthesisInput = (findingIds: string[], overrides: Record<string, unknown> = {}) => ({
  requestKey: "synthesis-1",
  principalId: "researcher-a",
  runRef: "run-001",
  conclusion: "Use leases with explicit renew.",
  findingIds,
  validAsOf: start,
  ...overrides,
});

const setup = async (clock: () => number = () => start) => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, services: createApplicationServices(database, undefined, clock) };
};

type Services = Awaited<ReturnType<typeof setup>>["services"];

/** ProjectとIntentを作り、Strategist Grantを付与する。Intent作成でInitial Requestが自動で1件作られる。 */
const seed = async (services: Services, principalId = "strat-1") => {
  const project = await services.createProjectUseCase.execute(projectInput);
  const intent = await services.createIntentUseCase.execute(project.id, intentInput);
  await services.grantProjectRoleUseCase.execute(project.id, { principalId, role: "strategist" });
  return { project, intent };
};

const briefOf = async (services: Services, projectId: string, principalId = "strat-1") =>
  (await services.getStrategistContextUseCase.execute(principalId, projectId)).research!;

test("cancelledのRequestはrequestsに残るが、syntheses（圧縮結果）からは除かれる", async () => {
  const { services } = await setup();
  const { project, intent } = await seed(services);
  const cancelled = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput(intent.id, { requestKey: "req-cancel" }),
  );
  const result = await services.registerResearchResultUseCase.execute(project.id, cancelled.id, resultInput());
  await services.registerResearchSynthesisUseCase.execute(
    project.id,
    cancelled.id,
    synthesisInput([result.findings[0]!.id]),
  );
  await services.cancelResearchRequestUseCase.execute(project.id, cancelled.id, { reason: "Superseded by a new plan" });

  const brief = await briefOf(services, project.id);
  const cancelledSummary = brief.requests.find((request) => request.id === cancelled.id);
  assert.equal(cancelledSummary?.status, "cancelled");
  assert.equal(
    brief.syntheses.some((synthesis) => synthesis.requestId === cancelled.id),
    false,
  );
});

test("supersedesIdで置き換えたSynthesisは古いversionを除き、最新versionだけを返す", async () => {
  const { services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput(intent.id, { requestKey: "req-1" }),
  );
  const result = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  const findingId = result.findings[0]!.id;
  const v1 = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([findingId], { requestKey: "syn-v1" }),
  );
  const v2 = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([findingId], { requestKey: "syn-v2", supersedesId: v1.id, conclusion: "Use leases with a shorter TTL." }),
  );

  const brief = await briefOf(services, project.id);
  const entries = brief.syntheses.filter((synthesis) => synthesis.requestId === request.id);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.synthesisId, v2.id);
  assert.equal(entries[0]!.version, 2);
  assert.equal(entries[0]!.conclusion, "Use leases with a shorter TTL.");

  // 置き換えられたv1も、ID指定のGetResearchRequestUseCaseからは引き続き辿れる（黙って消さない）。
  const detail = await services.getResearchRequestUseCase.execute(project.id, request.id);
  assert.deepEqual(
    detail.syntheses.map((synthesis) => synthesis.id).sort(),
    [v1.id, v2.id].sort(),
  );
});

test("宣言済みのFinding競合は平均化・除外せず、conflictsにそのまま残る", async () => {
  const { services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput(intent.id, { requestKey: "req-1" }),
  );
  const first = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({ requestKey: "result-a", findings: [{ statement: "Leases expire without heartbeats.", confidence: "high", observedAt: start, evidenceIndexes: [0] }] }),
  );
  const existingFindingId = first.findings[0]!.id;
  const second = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({
      requestKey: "result-b",
      findings: [
        {
          statement: "Leases never expire in practice.",
          confidence: "medium",
          observedAt: start,
          evidenceIndexes: [0],
          conflictsWithFindingIds: [existingFindingId],
        },
      ],
    }),
  );
  const conflictingFindingId = second.findings[0]!.id;
  await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([existingFindingId, conflictingFindingId]),
  );

  const brief = await briefOf(services, project.id);
  assert.deepEqual(brief.conflicts, [{ findingId: conflictingFindingId, conflictsWithFindingId: existingFindingId }]);
});

test("後から登録されたFindingが最新Synthesis未引用のまま競合を宣言しても、conflictsから消えない", async () => {
  const { services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput(intent.id, { requestKey: "req-1" }),
  );
  const first = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({ requestKey: "result-a", findings: [{ statement: "Leases expire without heartbeats.", confidence: "high", observedAt: start, evidenceIndexes: [0] }] }),
  );
  const citedFindingId = first.findings[0]!.id;
  // 最新SynthesisはF1のみを引用する（F2はまだ存在しない）。
  await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([citedFindingId]),
  );

  const second = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({
      requestKey: "result-b",
      findings: [
        {
          statement: "Leases never expire in practice.",
          confidence: "medium",
          observedAt: start,
          evidenceIndexes: [0],
          conflictsWithFindingIds: [citedFindingId],
        },
      ],
    }),
  );
  const laterFindingId = second.findings[0]!.id;
  // laterFindingIdを引用する新しいSynthesisは作らない。それでも既知の競合は黙って消えない。

  const brief = await briefOf(services, project.id);
  assert.deepEqual(brief.conflicts, [{ findingId: laterFindingId, conflictsWithFindingId: citedFindingId }]);
});

test("引用Findingが期限切れならstale:trueを返し、除外はしない", async () => {
  const { services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput(intent.id, { requestKey: "req-1" }),
  );
  const expired = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({
      requestKey: "result-expired",
      findings: [
        {
          statement: "Old finding.",
          confidence: "low",
          observedAt: start - 1_000,
          expiresAt: start - 500,
          evidenceIndexes: [0],
        },
      ],
    }),
  );
  const fresh = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({ requestKey: "result-fresh" }),
  );

  const staleSynthesis = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([expired.findings[0]!.id], { requestKey: "syn-stale" }),
  );
  const freshSynthesis = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([fresh.findings[0]!.id], { requestKey: "syn-fresh" }),
  );

  const brief = await briefOf(services, project.id);
  const byId = new Map(brief.syntheses.map((synthesis) => [synthesis.synthesisId, synthesis]));
  assert.equal(byId.get(staleSynthesis.id)?.stale, true);
  assert.equal(byId.get(freshSynthesis.id)?.stale, false);
});

test("別ProjectのRequest・Synthesisは、同名Intent IDであってもIntent Briefへ含まれない", async () => {
  const { services } = await setup();
  const { project } = await seed(services, "strat-1");
  const { project: otherProject, intent: otherIntent } = await seed(services, "strat-2");
  const otherRequest = await services.createResearchRequestUseCase.execute(
    otherProject.id,
    requestInput(otherIntent.id, { requestKey: "other-req" }),
  );
  const otherResult = await services.registerResearchResultUseCase.execute(otherProject.id, otherRequest.id, resultInput());
  await services.registerResearchSynthesisUseCase.execute(
    otherProject.id,
    otherRequest.id,
    synthesisInput([otherResult.findings[0]!.id]),
  );

  const brief = await briefOf(services, project.id, "strat-1");
  assert.ok(brief.requests.every((request) => request.id !== otherRequest.id));
  assert.ok(brief.syntheses.every((synthesis) => synthesis.requestId !== otherRequest.id));
});
