import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const projectInput = { name: "Compass", mission: "Keep direction explicit" };
const intentInput = { title: "Agents improve software", desiredState: "Agents improve the software." };
const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  rationale: "Duplicate claims cause rework.",
  successCriteria: [{ description: "duplicates = 0", measurement: "Count duplicates" }],
};

const start = 1_800_000_000_000;

const requestInput = (overrides: Record<string, unknown> = {}) => ({
  requestKey: "request-1",
  kind: "decision",
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
  budgetUsed: 30,
  evidenceRefs: [
    { kind: "url", uri: "https://example.com/leases", retrievedAt: start, versionHash: "sha256:abc" },
    { kind: "repository_file", uri: "docs/claims.md", retrievedAt: start },
  ],
  findings: [
    {
      statement: "Leases expire without heartbeats.",
      confidence: "high",
      observedAt: start,
      expiresAt: start + 86_400_000,
      evidenceIndexes: [0, 1],
    },
    { statement: "Locks can stall workers.", confidence: "medium", observedAt: start, evidenceIndexes: [1] },
  ],
  unknowns: ["Behaviour under clock skew"],
  options: ["Lease with renew"],
  risks: ["Renew storms"],
  ...overrides,
});

const synthesisInput = (findingIds: string[], overrides: Record<string, unknown> = {}) => ({
  requestKey: "synthesis-1",
  principalId: "researcher-a",
  runRef: "run-001",
  conclusion: "Use leases with explicit renew.",
  findingIds,
  risks: ["Renew storms"],
  options: ["Lease with renew"],
  unknowns: ["Behaviour under clock skew"],
  validAsOf: start,
  ...overrides,
});

const setup = async (path = ":memory:", clock: () => number = () => start) => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database, undefined, clock) };
};

type Services = Awaited<ReturnType<typeof setup>>["services"];

const seed = async (services: Services) => {
  const project = await services.createProjectUseCase.execute(projectInput);
  const intent = await services.createIntentUseCase.execute(project.id, intentInput);
  return { project, intent };
};

type Rejection = { code?: string; details?: Record<string, string>; issues?: { path: string }[] };
const rejectsWith = (code: string, check: (error: Rejection) => void = () => {}) => (error: unknown) => {
  assert.equal((error as Rejection).code, code);
  check(error as Rejection);
  return true;
};

const rowCount = async (database: Awaited<ReturnType<typeof setup>>["database"], table: string) => {
  const { rows } = await sql<{ count: number }>`select count(*) as count from ${sql.table(table)}`.execute(database);
  return rows[0]!.count;
};

test("Requestは発端Intentとともに保存され、再起動後も同じID・順序で取得できる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  const initial = await initialRequestOf(first.services, project.id, intent.id);
  const created = await first.services.createResearchRequestUseCase.execute(
    project.id,
    requestInput({ kind: "project_watch", deadlineAt: start + 3_600_000, correlationId: "corr-1" }),
  );
  const second = await first.services.createResearchRequestUseCase.execute(
    project.id,
    requestInput({ requestKey: "request-2", originIntentId: intent.id }),
  );
  assert.equal(created.status, "requested");
  assert.equal(created.kind, "project_watch");
  assert.equal(created.originIntentId, null);
  assert.equal(created.projectId, project.id);
  assert.equal(created.budgetUsed, 0);
  assert.equal(created.stopReason, null);
  assert.equal(created.correlationId, "corr-1");
  assert.equal(second.originIntentId, intent.id);
  assert.ok(second.correlationId.length > 0);
  await first.database.destroy();

  const restarted = await setup(path);
  assert.deepEqual(
    (await restarted.services.getResearchRequestUseCase.execute(project.id, created.id)).request,
    created,
  );
  assert.deepEqual(
    (await restarted.services.listResearchRequestsUseCase.execute(project.id)).map(({ id }) => id),
    [second.id, created.id, initial.id],
  );
  assert.deepEqual(
    (await restarted.services.listResearchRequestsUseCase.execute(project.id, { originIntentId: intent.id })).map(
      ({ id }) => id,
    ),
    [second.id, initial.id],
  );
  await restarted.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

/** Intent作成時に自動作成されたInitial Request。以降の件数・一覧の期待値はこれを含める。 */
const initialRequestOf = async (services: Services, projectId: string, intentId: string) => {
  const [initial, ...rest] = await services.listResearchRequestsUseCase.execute(projectId, { originIntentId: intentId });
  assert.ok(initial && rest.length === 0, "Intent作成でInitial Requestが1件だけ作成されている");
  return initial;
};

// decision requestはIntentが必須なので、Intent付きで作る。
const decisionRequest = (intentId: string, overrides: Record<string, unknown> = {}) =>
  requestInput({ originIntentId: intentId, ...overrides });

test("Result・Finding・Synthesisを登録して完了でき、Projectと発端Intentから来歴を辿れて再起動後も変わらない", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-research-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  const initial = await initialRequestOf(first.services, project.id, intent.id);
  const request = await first.services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const result = await first.services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());

  assert.equal(result.sequence, 1);
  assert.equal(result.principalId, "researcher-a");
  assert.equal(result.runRef, "run-001");
  assert.deepEqual(result.unknowns, ["Behaviour under clock skew"]);
  assert.deepEqual(
    result.evidenceRefs.map(({ position, kind, uri, versionHash }) => [position, kind, uri, versionHash]),
    [
      [0, "url", "https://example.com/leases", "sha256:abc"],
      [1, "repository_file", "docs/claims.md", null],
    ],
  );
  assert.deepEqual(
    result.findings.map(({ position, statement, expiresAt }) => [position, statement, expiresAt]),
    [
      [0, "Leases expire without heartbeats.", start + 86_400_000],
      [1, "Locks can stall workers.", null],
    ],
  );
  // FindingはResultのEvidence参照だけを指し、来歴（Principal / run）を引き継ぐ。
  assert.deepEqual(result.findings[0]!.evidenceRefIds, result.evidenceRefs.map(({ id }) => id));
  assert.deepEqual(result.findings[1]!.evidenceRefIds, [result.evidenceRefs[1]!.id]);
  assert.ok(result.findings.every((finding) => finding.projectId === project.id && finding.requestId === request.id));
  assert.ok(result.findings.every((finding) => finding.principalId === "researcher-a" && finding.runRef === "run-001"));

  const running = (await first.services.getResearchRequestUseCase.execute(project.id, request.id)).request;
  assert.equal(running.status, "running");
  assert.equal(running.budgetUsed, 30);

  const synthesis = await first.services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput(result.findings.map(({ id }) => id), { validAsOf: start + 1 }),
  );
  assert.equal(synthesis.version, 1);
  assert.equal(synthesis.supersedesId, null);
  assert.deepEqual(synthesis.findingIds, result.findings.map(({ id }) => id));
  assert.equal(synthesis.validAsOf, start + 1);

  const completed = await first.services.completeResearchRequestUseCase.execute(project.id, request.id, {
    conclusion: "completed",
  });
  assert.equal(completed.status, "completed");
  assert.equal(completed.stopReason, null);
  const detail = await first.services.getResearchRequestUseCase.execute(project.id, request.id);
  assert.deepEqual(detail, { request: completed, results: [result], syntheses: [synthesis] });
  await first.database.destroy();

  const restarted = await setup(path);
  assert.deepEqual(await restarted.services.getResearchRequestUseCase.execute(project.id, request.id), detail);
  assert.deepEqual(
    (await restarted.services.listResearchRequestsUseCase.execute(project.id, { originIntentId: intent.id })).map(
      ({ id, status }) => [id, status],
    ),
    [
      [request.id, "completed"],
      [initial.id, "requested"],
    ],
  );
  await restarted.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("Resultはsequence順に追記され、使用予算が加算される", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const one = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  const two = await services.registerResearchResultUseCase.execute(
    project.id,
    request.id,
    resultInput({ requestKey: "result-2", budgetUsed: 20, evidenceRefs: [], findings: [] }),
  );
  assert.deepEqual([one.sequence, two.sequence], [1, 2]);
  const detail = await services.getResearchRequestUseCase.execute(project.id, request.id);
  assert.deepEqual(detail.results.map(({ id }) => id), [one.id, two.id]);
  assert.equal(detail.request.budgetUsed, 50);
  await database.destroy();
});

test("completed / insufficient / not_needed / cancelled を区別して確定でき、確定後の更新を拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const create = (key: string) =>
    services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id, { requestKey: key }));

  const insufficient = await create("k-insufficient");
  await services.registerResearchResultUseCase.execute(project.id, insufficient.id, resultInput());
  const closedInsufficient = await services.completeResearchRequestUseCase.execute(project.id, insufficient.id, {
    conclusion: "insufficient",
    stopReason: "Budget reached before evidence was found",
  });
  assert.equal(closedInsufficient.status, "insufficient");
  assert.equal(closedInsufficient.stopReason, "Budget reached before evidence was found");

  // 既存知識だけで判断できる場合、Resultなしでnot_neededを確定できる。
  const notNeeded = await create("k-not-needed");
  const closedNotNeeded = await services.completeResearchRequestUseCase.execute(project.id, notNeeded.id, {
    conclusion: "not_needed",
    stopReason: "Existing Constraints already decide this",
  });
  assert.equal(closedNotNeeded.status, "not_needed");

  const cancelled = await create("k-cancelled");
  const closedCancelled = await services.cancelResearchRequestUseCase.execute(project.id, cancelled.id, {
    reason: "Intent direction changed",
  });
  assert.equal(closedCancelled.status, "cancelled");
  assert.equal(closedCancelled.stopReason, "Intent direction changed");

  const completed = await create("k-completed");
  const registered = await services.registerResearchResultUseCase.execute(project.id, completed.id, resultInput());
  await services.registerResearchSynthesisUseCase.execute(
    project.id,
    completed.id,
    synthesisInput(registered.findings.map(({ id }) => id)),
  );
  await services.completeResearchRequestUseCase.execute(project.id, completed.id, { conclusion: "completed" });

  for (const closed of [insufficient, notNeeded, cancelled, completed]) {
    const before = await services.getResearchRequestUseCase.execute(project.id, closed.id);
    const conflict = rejectsWith("CONFLICT", (error) => assert.equal(error.details?.status, before.request.status));
    await assert.rejects(
      services.registerResearchResultUseCase.execute(
        project.id,
        closed.id,
        resultInput({ requestKey: "late-result", evidenceRefs: [], findings: [] }),
      ),
      conflict,
    );
    await assert.rejects(
      services.registerResearchSynthesisUseCase.execute(
        project.id,
        closed.id,
        synthesisInput(registered.findings.map(({ id }) => id), { requestKey: "late-synthesis" }),
      ),
      conflict,
    );
    await assert.rejects(
      services.completeResearchRequestUseCase.execute(project.id, closed.id, {
        conclusion: "not_needed",
        stopReason: "again",
      }),
      conflict,
    );
    await assert.rejects(services.cancelResearchRequestUseCase.execute(project.id, closed.id, { reason: "again" }), conflict);
    assert.deepEqual(await services.getResearchRequestUseCase.execute(project.id, closed.id), before);
  }
  await database.destroy();
});

test("completedはResultとSynthesisが必要で、insufficient / not_neededは停止理由が必要", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));

  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, request.id, { conclusion: "completed" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.missing, "result")),
  );
  const result = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, request.id, { conclusion: "completed" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.missing, "synthesis")),
  );
  for (const conclusion of ["insufficient", "not_needed"]) {
    await assert.rejects(
      services.completeResearchRequestUseCase.execute(project.id, request.id, { conclusion }),
      rejectsWith("VALIDATION_ERROR", (error) => assert.deepEqual(error.issues?.map(({ path }) => path), ["stopReason"])),
    );
  }
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, request.id, { conclusion: "cancelled", stopReason: "x" }),
    rejectsWith("VALIDATION_ERROR"),
  );
  await assert.rejects(
    services.cancelResearchRequestUseCase.execute(project.id, request.id, { reason: " " }),
    rejectsWith("VALIDATION_ERROR"),
  );
  const status = (await services.getResearchRequestUseCase.execute(project.id, request.id)).request.status;
  assert.equal(status, "running");
  assert.equal(result.sequence, 1);
  await database.destroy();
});

test("同じrequestKeyと内容の再送は重複を作らず、内容が異なる再利用は拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const input = decisionRequest(intent.id);
  const request = await services.createResearchRequestUseCase.execute(project.id, input);
  assert.deepEqual(await services.createResearchRequestUseCase.execute(project.id, { ...input }), request);
  await assert.rejects(
    services.createResearchRequestUseCase.execute(project.id, { ...input, question: "A different question?" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.requestKey, "request-1")),
  );
  // Intent作成時のInitial Requestと、この明示的なRequestの2件。再送・拒否では増えない。
  assert.equal(await rowCount(database, "research_request"), 2);

  const result = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  assert.deepEqual(await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput()), result);
  await assert.rejects(
    services.registerResearchResultUseCase.execute(project.id, request.id, resultInput({ summary: "Changed" })),
    rejectsWith("CONFLICT"),
  );
  assert.equal(await rowCount(database, "research_result"), 1);
  assert.equal(await rowCount(database, "research_finding"), 2);
  assert.equal(await rowCount(database, "research_evidence_ref"), 2);
  // 使用予算は再送で二重に加算しない。
  assert.equal((await services.getResearchRequestUseCase.execute(project.id, request.id)).request.budgetUsed, 30);

  const findingIds = result.findings.map(({ id }) => id);
  const synthesis = await services.registerResearchSynthesisUseCase.execute(project.id, request.id, synthesisInput(findingIds));
  assert.deepEqual(
    await services.registerResearchSynthesisUseCase.execute(project.id, request.id, synthesisInput(findingIds)),
    synthesis,
  );
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(
      project.id,
      request.id,
      synthesisInput(findingIds, { conclusion: "Changed" }),
    ),
    rejectsWith("CONFLICT"),
  );
  assert.equal(await rowCount(database, "research_synthesis"), 1);

  // 確定後に届いた再送は、状態違反ではなく作成済みの結果として返す。
  await services.completeResearchRequestUseCase.execute(project.id, request.id, { conclusion: "completed" });
  assert.deepEqual(await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput()), result);
  await database.destroy();
});

test("Synthesisはsupersedesでversionを追加し、上書きも分岐もしない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const result = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  const findingIds = result.findings.map(({ id }) => id);

  const v1 = await services.registerResearchSynthesisUseCase.execute(project.id, request.id, synthesisInput(findingIds));
  const v2 = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    request.id,
    synthesisInput([findingIds[0]!], { requestKey: "synthesis-2", supersedesId: v1.id, conclusion: "Refined" }),
  );
  assert.equal(v2.version, 2);
  assert.equal(v2.supersedesId, v1.id);
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(
      project.id,
      request.id,
      synthesisInput(findingIds, { requestKey: "synthesis-3", supersedesId: v1.id }),
    ),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.supersededById, v2.id)),
  );
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(
      project.id,
      request.id,
      synthesisInput(findingIds, { requestKey: "synthesis-4", supersedesId: "missing" }),
    ),
    rejectsWith("VALIDATION_ERROR", (error) => assert.deepEqual(error.issues?.map(({ path }) => path), ["supersedesId"])),
  );

  const detail = await services.getResearchRequestUseCase.execute(project.id, request.id);
  assert.deepEqual(detail.syntheses, [v1, v2]);
  assert.equal(v1.conclusion, "Use leases with explicit renew.");
  await database.destroy();
});

test("Findingは競合を宣言でき、後続Requestやversionから同じProjectのFindingを再利用できる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const first = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const firstResult = await services.registerResearchResultUseCase.execute(project.id, first.id, resultInput());
  const [existing] = firstResult.findings;

  const second = await services.createResearchRequestUseCase.execute(
    project.id,
    decisionRequest(intent.id, { requestKey: "request-2" }),
  );
  const secondResult = await services.registerResearchResultUseCase.execute(
    project.id,
    second.id,
    resultInput({
      requestKey: "result-2",
      findings: [
        {
          statement: "Leases do not expire under skew.",
          confidence: "low",
          observedAt: start,
          evidenceIndexes: [0],
          conflictsWithFindingIds: [existing!.id],
        },
      ],
    }),
  );
  assert.deepEqual(secondResult.findings[0]!.conflictsWithFindingIds, [existing!.id]);
  // 競合は宣言されたまま残り、元のFindingは変更されない。
  const reloaded = await services.getResearchRequestUseCase.execute(project.id, first.id);
  assert.deepEqual(reloaded.results[0]!.findings[0], existing);

  const reused = await services.registerResearchSynthesisUseCase.execute(
    project.id,
    second.id,
    synthesisInput([existing!.id, secondResult.findings[0]!.id]),
  );
  assert.deepEqual(reused.findingIds, [existing!.id, secondResult.findings[0]!.id]);

  await assert.rejects(
    services.registerResearchResultUseCase.execute(
      project.id,
      second.id,
      resultInput({
        requestKey: "result-3",
        findings: [
          {
            statement: "x",
            confidence: "low",
            observedAt: start,
            evidenceIndexes: [0],
            conflictsWithFindingIds: ["missing-finding"],
          },
        ],
      }),
    ),
    rejectsWith("VALIDATION_ERROR"),
  );
  await database.destroy();
});

test("別ProjectのIDの混在と存在しない参照を拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const other = await services.createProjectUseCase.execute({ ...projectInput, name: "Other" });
  const otherIntent = await services.createIntentUseCase.execute(other.id, intentInput);
  const otherOutcome = await services.createOutcomeUseCase.execute(other.id, otherIntent.id, outcomeInput);
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);

  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const otherRequest = await services.createResearchRequestUseCase.execute(
    other.id,
    decisionRequest(otherIntent.id, { requestKey: "other-request" }),
  );
  const otherResult = await services.registerResearchResultUseCase.execute(other.id, otherRequest.id, resultInput());

  // 別ProjectのIntent / Outcomeは発端にできない。
  await assert.rejects(
    services.createResearchRequestUseCase.execute(project.id, decisionRequest(otherIntent.id, { requestKey: "x" })),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(
    services.createResearchRequestUseCase.execute(
      project.id,
      decisionRequest(intent.id, { requestKey: "y", originOutcomeId: otherOutcome.id }),
    ),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(
    services.createResearchRequestUseCase.execute(
      project.id,
      decisionRequest("missing-intent", { requestKey: "z" }),
    ),
    rejectsWith("NOT_FOUND"),
  );
  const withOutcome = await services.createResearchRequestUseCase.execute(
    project.id,
    decisionRequest(intent.id, { requestKey: "with-outcome", originOutcomeId: outcome.id }),
  );
  assert.equal(withOutcome.originOutcomeId, outcome.id);

  // 別ProjectのRequestは、取得・登録・確定のいずれでも存在しないものとして扱う。
  await assert.rejects(services.getResearchRequestUseCase.execute(project.id, otherRequest.id), rejectsWith("NOT_FOUND"));
  await assert.rejects(
    services.registerResearchResultUseCase.execute(project.id, otherRequest.id, resultInput()),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(project.id, otherRequest.id, {
      conclusion: "not_needed",
      stopReason: "x",
    }),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(
    services.cancelResearchRequestUseCase.execute(project.id, otherRequest.id, { reason: "x" }),
    rejectsWith("NOT_FOUND"),
  );
  await assert.rejects(services.listResearchRequestsUseCase.execute("missing-project"), rejectsWith("NOT_FOUND"));

  // 別Projectや存在しないFindingはSynthesisにもFindingの競合宣言にも使えない。
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(
      project.id,
      request.id,
      synthesisInput(otherResult.findings.map(({ id }) => id)),
    ),
    rejectsWith("VALIDATION_ERROR", (error) => assert.deepEqual(error.issues?.map(({ path }) => path), ["findingIds"])),
  );
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(project.id, request.id, synthesisInput(["missing"])),
    rejectsWith("VALIDATION_ERROR"),
  );
  await assert.rejects(
    services.registerResearchResultUseCase.execute(
      project.id,
      request.id,
      resultInput({
        findings: [
          {
            statement: "x",
            confidence: "low",
            observedAt: start,
            evidenceIndexes: [0],
            conflictsWithFindingIds: [otherResult.findings[0]!.id],
          },
        ],
      }),
    ),
    rejectsWith("VALIDATION_ERROR"),
  );
  // 別Projectの操作は、どちらのProjectのResearchも変更しない。
  assert.equal((await services.getResearchRequestUseCase.execute(other.id, otherRequest.id)).request.status, "running");
  assert.equal((await services.getResearchRequestUseCase.execute(project.id, request.id)).results.length, 0);
  await database.destroy();
});

test("期限・予算・状態・入力の不正値を拒否する", async () => {
  let now = start;
  const { database, services } = await setup(":memory:", () => now);
  const { project, intent } = await seed(services);
  const invalid = async (overrides: Record<string, unknown>, path: string) =>
    assert.rejects(
      services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id, overrides)),
      rejectsWith("VALIDATION_ERROR", (error) => assert.ok(error.issues?.some((issue) => issue.path === path), path)),
    );
  await invalid({ budgetTotal: 0 }, "budgetTotal");
  await invalid({ budgetTotal: -1 }, "budgetTotal");
  await invalid({ budgetTotal: 1.5 }, "budgetTotal");
  await invalid({ budgetTotal: 10_001 }, "budgetTotal");
  await invalid({ deadlineAt: start }, "deadlineAt");
  await invalid({ deadlineAt: start - 1 }, "deadlineAt");
  await invalid({ deadlineAt: -5 }, "deadlineAt");
  await invalid({ question: "  " }, "question");
  await invalid({ requestKey: "" }, "requestKey");
  await invalid({ kind: "unknown" }, "kind");
  await invalid({ originIntentId: undefined }, "originIntentId");
  await invalid({ originOutcomeId: "outcome-without-check", originIntentId: undefined }, "originIntentId");
  await assert.rejects(
    services.createResearchRequestUseCase.execute(project.id, requestInput({ kind: "project_watch", originIntentId: intent.id })),
    rejectsWith("VALIDATION_ERROR"),
  );
  // 不正な入力は保存しない。残るのはIntent作成時のInitial Requestだけ。
  assert.equal(await rowCount(database, "research_request"), 1);

  const watch = await services.createResearchRequestUseCase.execute(
    project.id,
    requestInput({ kind: "project_watch", requestKey: "watch" }),
  );
  assert.equal(watch.kind, "project_watch");
  assert.equal(watch.originIntentId, null);

  const request = await services.createResearchRequestUseCase.execute(
    project.id,
    decisionRequest(intent.id, { requestKey: "bounded", budgetTotal: 50, deadlineAt: start + 1_000 }),
  );
  const badResult = async (overrides: Record<string, unknown>, path: string) =>
    assert.rejects(
      services.registerResearchResultUseCase.execute(project.id, request.id, resultInput(overrides)),
      rejectsWith("VALIDATION_ERROR", (error) => assert.ok(error.issues?.some((issue) => issue.path === path), path)),
    );
  await badResult({ budgetUsed: -1 }, "budgetUsed");
  await badResult({ principalId: "" }, "principalId");
  await badResult({ runRef: " " }, "runRef");
  await badResult({ summary: "" }, "summary");
  await badResult({ evidenceRefs: [{ kind: "url", uri: "not a url", retrievedAt: start }] }, "evidenceRefs.0.uri");
  await badResult({ evidenceRefs: [{ kind: "smoke_signal", uri: "x", retrievedAt: start }] }, "evidenceRefs.0.kind");
  await badResult(
    { findings: [{ statement: "s", confidence: "low", observedAt: start, evidenceIndexes: [5] }] },
    "findings.0.evidenceIndexes.0",
  );
  await badResult(
    { findings: [{ statement: "s", confidence: "low", observedAt: start, evidenceIndexes: [] }] },
    "findings.0.evidenceIndexes",
  );
  await badResult(
    { findings: [{ statement: "s", confidence: "certain", observedAt: start, evidenceIndexes: [0] }] },
    "findings.0.confidence",
  );
  await badResult(
    { findings: [{ statement: "s", confidence: "low", observedAt: start, expiresAt: start, evidenceIndexes: [0] }] },
    "findings.0.expiresAt",
  );
  assert.equal(await rowCount(database, "research_result"), 0);

  // 予算超過は登録せず、使用済み予算も変えない。
  await assert.rejects(
    services.registerResearchResultUseCase.execute(project.id, request.id, resultInput({ budgetUsed: 51 })),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.budgetTotal, "50")),
  );
  assert.equal((await services.getResearchRequestUseCase.execute(project.id, request.id)).request.budgetUsed, 0);
  await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput({ budgetUsed: 50 }));
  await assert.rejects(
    services.registerResearchResultUseCase.execute(
      project.id,
      request.id,
      resultInput({ requestKey: "result-2", budgetUsed: 1, evidenceRefs: [], findings: [] }),
    ),
    rejectsWith("CONFLICT"),
  );

  // 期限後は新しいResult / Synthesisを受け付けず、insufficientで終了できる。
  now = start + 1_001;
  await assert.rejects(
    services.registerResearchResultUseCase.execute(
      project.id,
      request.id,
      resultInput({ requestKey: "result-3", budgetUsed: 0, evidenceRefs: [], findings: [] }),
    ),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.deadlineAt, String(start + 1_000))),
  );
  await assert.rejects(
    services.registerResearchSynthesisUseCase.execute(project.id, request.id, synthesisInput(["any"])),
    rejectsWith("CONFLICT"),
  );
  const closed = await services.completeResearchRequestUseCase.execute(project.id, request.id, {
    conclusion: "insufficient",
    stopReason: "Deadline reached",
  });
  assert.equal(closed.status, "insufficient");
  await database.destroy();
});

test("abandonedのIntentとarchivedのProjectには新しいRequestもResearchの書込も作らない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  await services.abandonIntentUseCase.execute(project.id, intent.id, { reason: "Changed direction" });
  await assert.rejects(
    services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id, { requestKey: "after-abandon" })),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.status, "abandoned")),
  );
  // Initial Requestと明示的なRequestの2件のまま。放棄後の新しいRequestは作られない。
  assert.equal(await rowCount(database, "research_request"), 2);
  // 放棄されたIntentの未終了Requestは同じtransactionで取り消され、取消はRuntimeイベントにならない。
  const abandoned = await services.listResearchRequestsUseCase.execute(project.id, { originIntentId: intent.id });
  assert.deepEqual(
    abandoned.map(({ status, stopReason }) => [status, stopReason]),
    [
      ["cancelled", "Intent abandoned: Changed direction"],
      ["cancelled", "Intent abandoned: Changed direction"],
    ],
  );
  assert.deepEqual(
    (await services.listRuntimeEventsUseCase.execute(project.id)).map(({ type }) => type),
    ["research_requested", "research_requested"],
  );

  // archived側は、未終了のRequestを持つ別のProjectで確かめる。
  const archived = await seed(services);
  const archivedIntent = archived.intent;
  const request2 = await services.createResearchRequestUseCase.execute(archived.project.id, decisionRequest(archivedIntent.id));
  await services.archiveProjectUseCase.execute(archived.project.id, { reason: "Done" });
  await assert.rejects(
    services.createResearchRequestUseCase.execute(archived.project.id, decisionRequest(archivedIntent.id, { requestKey: "after-archive" })),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.projectStatus, "archived")),
  );
  await assert.rejects(
    services.registerResearchResultUseCase.execute(archived.project.id, request2.id, resultInput()),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.projectStatus, "archived")),
  );
  await assert.rejects(
    services.completeResearchRequestUseCase.execute(archived.project.id, request2.id, { conclusion: "not_needed", stopReason: "x" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.projectStatus, "archived")),
  );
  await assert.rejects(
    services.cancelResearchRequestUseCase.execute(archived.project.id, request2.id, { reason: "x" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.projectStatus, "archived")),
  );
  // 閲覧はarchived後も可能で、状態は変わらない。
  assert.equal((await services.getResearchRequestUseCase.execute(archived.project.id, request2.id)).request.status, "requested");
  await database.destroy();
});

test("DBの制約が同じrequestKeyの重複とIntentのないdecision requestを拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const row = {
    project_id: project.id,
    input_hash: "h",
    kind: "decision" as const,
    origin_intent_id: intent.id,
    origin_outcome_id: null,
    question: "q",
    scope: "s",
    completion_condition: "c",
    budget_total: 1,
    budget_used: 0,
    deadline_at: null,
    status: "requested" as const,
    stop_reason: null,
    correlation_id: "c",
    created_at: start,
    updated_at: start,
  };
  await assert.rejects(
    database.insertInto("research_request").values({ ...row, id: "dup", request_key: request.requestKey }).execute(),
  );
  await assert.rejects(
    database
      .insertInto("research_request")
      .values({ ...row, id: "no-intent", request_key: "no-intent", origin_intent_id: null })
      .execute(),
  );
  await assert.rejects(
    database
      .insertInto("research_request")
      .values({ ...row, id: "overspent", request_key: "overspent", budget_used: 2 })
      .execute(),
  );
  // Intent作成時のInitial Requestと、直接挿入した1件。制約違反の行は残らない。
  assert.equal(await rowCount(database, "research_request"), 2);
  await database.destroy();
});

test("initializeSchemaは再実行してもResearchとProject / Intent / Outcomeを壊さず、Research導入前のDBにも追加できる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const request = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  const result = await services.registerResearchResultUseCase.execute(project.id, request.id, resultInput());
  const before = await services.getResearchRequestUseCase.execute(project.id, request.id);

  await initializeSchema(database);
  assert.deepEqual(await services.getResearchRequestUseCase.execute(project.id, request.id), before);
  assert.deepEqual(before.results, [result]);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id), outcome);
  assert.equal((await services.getIntentUseCase.execute(project.id, intent.id)).id, intent.id);

  // Research導入前のDB（Researchのtableが無い）でも、追加して既存のデータを保つ。
  for (const table of [
    "runtime_event",
    "research_synthesis_finding",
    "research_synthesis",
    "research_finding_conflict",
    "research_finding_evidence",
    "research_finding",
    "research_evidence_ref",
    "research_result",
    "research_request",
  ]) {
    await database.schema.dropTable(table).execute();
  }
  await initializeSchema(database);
  // Research導入前のActive Intentには、再初期化でInitial Requestが1件だけ補われる（Intent・Outcomeには触れない）。
  assert.equal(await rowCount(database, "research_request"), 1);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id), outcome);
  const recreated = await services.createResearchRequestUseCase.execute(project.id, decisionRequest(intent.id));
  assert.equal(recreated.status, "requested");
  await database.destroy();
});
