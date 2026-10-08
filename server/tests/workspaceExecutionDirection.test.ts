import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

// Projectが存在しなくてもWorkspace Directionの確定イベントを保存する。
test("Direction events belong to Workspace without fabricating a Project", async () => {
  const database = createDatabase(":memory:");
  try {
    await initializeSchema(database);
    const services = createApplicationServices(database);
    const workspace = await services.human.createWorkspace.execute({ name: "Workspace", mission: "Mission" });
    const intent = await services.workspaceDirection.createIntentUseCase.execute(workspace.id, { title: "Intent", desiredState: "Result" });
    const outcome = await services.workspaceDirection.createOutcomeUseCase.execute(workspace.id, intent.id, {
      title: "Outcome", description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }],
    });
    const events = await database.selectFrom("runtime_event").selectAll().execute();
    assert.equal(events.length, 1);
    assert.equal(events[0]!.workspace_id, workspace.id);
    assert.equal("project_id" in events[0]!, false);
    assert.equal(events[0]!.outcome_id, outcome.id);
    assert.equal(events[0]!.correlation_id, `outcome:${outcome.id}`);
  } finally { await database.destroy(); }
});

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "kysely";
import { SQLiteOutcomeExecutionRepository, type RecordOutcomeExecutionInput } from "@compass/direction";
import { CreateWorkspaceProjectUseCase, SQLiteProjectRepository, SQLiteWorkspaceRepository } from "@compass/organization";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { asDirectionDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { directionProjectReaders, directionWorkspaceReaders, projectRepositoryReferenceFinder } from "../src/infrastructure/repository/contextAdapters.ts";

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Workspace", mission: "Mission" });
  const other = await services.human.createWorkspace.execute({ name: "Other", mission: "Other" });
  const createProject = new CreateWorkspaceProjectUseCase(new SQLiteProjectRepository(asOrganizationDatabase(database), projectRepositoryReferenceFinder));
  const a = await createProject.execute(workspace.id, { name: "A" });
  const b = await createProject.execute( workspace.id, { name: "B" });
  const foreign = await createProject.execute( other.id, { name: "Foreign" });
  const direction = services.workspaceDirection;
  const intent = await direction.createIntentUseCase.execute(workspace.id, { title: "Intent", desiredState: "Result" });
  const outcome = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, {
    title: "Outcome", description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }],
  });
  // 還流はOutcomeのTarget Projectだけが行える。
  for (const project of [a, b]) await direction.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, project.id);
  const repository = new SQLiteOutcomeExecutionRepository(asDirectionDatabase(database), directionProjectReaders, directionWorkspaceReaders);
  const input: RecordOutcomeExecutionInput = {
    outcomeId: outcome.id, correlationId: `outcome:${outcome.id}`, state: "accepted", stories: [], executionCursor: 10,
    changeCursor: 10, evidence: [{ kind: "url", uri: "https://example.com/result", versionHash: null, observedAt: 1 }], principalId: "runtime", at: 2,
  };
  return { database, services, direction, workspace, other, a, b, foreign, intent, outcome, repository, input };
};

const judgment = (outcome: { successCriteria: readonly { id: string }[] }, evidenceId: string, requestKey = "evaluation") => ({
  requestKey, runRef: "test-run", criteria: [{ criterionId: outcome.successCriteria[0]!.id, verdict: "met", rationale: "Observed", evidenceIds: [evidenceId] }],
});

test("Workspace execution storage isolates each Project's cursor and Evidence and rejects cross-scope writes", async () => {
  const kit = await setup();
  const { database, workspace, other, a, b, foreign, outcome, repository, input, direction } = kit;
  try {
    const first = await repository.record(workspace.id, a.id, input);
    assert.equal(first.kind, "recorded");
    if (first.kind !== "recorded") throw new Error("record missing");
    const replay = await repository.record(workspace.id, a.id, input);
    assert.equal(replay.kind, "recorded");
    if (replay.kind !== "recorded") throw new Error("record missing");
    assert.equal(replay.summaryChanged, false);
    assert.equal(replay.evidenceAdded, 0);
    await repository.record(workspace.id, b.id, { ...input, executionCursor: 3, changeCursor: 3, state: "incomplete" });
    await repository.record(workspace.id, a.id, { ...input, executionCursor: 11, changeCursor: 8 });
    const records = await repository.findByOutcome(workspace.id, outcome.id);
    assert.equal(records.length, 2);
    const byProject = new Map(records.map(record => [record.summary.projectId, record]));
    assert.equal(byProject.get(a.id)!.summary.executionCursor, 11);
    assert.equal(byProject.get(b.id)!.summary.executionCursor, 3);
    assert.equal(byProject.get(b.id)!.summary.state, "incomplete");
    assert.notEqual(byProject.get(a.id)!.evidence[0]!.id, byProject.get(b.id)!.evidence[0]!.id);
    assert.ok(records.every(record => record.summary.workspaceId === workspace.id && record.evidence.every(item => item.workspaceId === workspace.id)));
    assert.deepEqual(await repository.findByOutcome(other.id, outcome.id), []);
    assert.equal(await repository.find(other.id, a.id, outcome.id), null);
    await assert.rejects(repository.record(workspace.id, foreign.id, input), { code: "NOT_FOUND" });
    await assert.rejects(repository.record(other.id, foreign.id, input), { code: "NOT_FOUND" });
    await assert.rejects(direction.recordExecutionEvidenceUseCase.execute("runtime", workspace.id, foreign.id, outcome.id, { changeCursor: 0 }), { code: "NOT_FOUND" });
    // 一部のTarget（A）の完了だけでは評価しない。BがExecution中の間は還流待ち。
    await assert.rejects(direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id,
      judgment(outcome, first.record.evidence[0]!.id)), { code: "CONFLICT", details: { reason: "awaiting_execution", unfinishedProjectIds: b.id } });
    const row = await database.selectFrom("outcome_execution_summary").selectAll().where("project_id", "=", a.id).executeTakeFirstOrThrow();
    await assert.rejects(database.insertInto("outcome_execution_summary").values({ ...row, project_id: foreign.id }).execute(), /FOREIGN KEY/);
    await assert.rejects(database.updateTable("outcome_execution_evidence").set({ workspace_id: other.id }).execute(), /FOREIGN KEY/);
    const event = await database.selectFrom("runtime_event").selectAll().executeTakeFirstOrThrow();
    await assert.rejects(database.updateTable("runtime_event").set({ workspace_id: other.id }).where("id", "=", event.id).execute(), /FOREIGN KEY/);
    await assert.rejects(database.insertInto("runtime_event_delivery").values({ workspace_id: other.id, event_sequence: event.sequence, consumer_id: "runtime", outcome: "processed", retry_count: 0, last_failure_reason: null, created_at: 1, updated_at: 1 }).execute(), /FOREIGN KEY/);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally { await database.destroy(); }
});

test("Workspace Evaluation, Evidence and event/ack persist on file DB reopen, with Workspace-only Activity and replay", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-workspace-execution-"));
  const path = join(directory, "compass.db");
  let database: ReturnType<typeof createDatabase> | undefined;
  try {
    const kit = await setup(path);
    database = kit.database;
    const { workspace, other, a, outcome, input, repository, direction } = kit;
    const saved = await repository.record(workspace.id, a.id, input);
    if (saved.kind !== "recorded") throw new Error("record missing");
    await repository.record(workspace.id, kit.b.id, { ...input, executionCursor: 4, changeCursor: 4 });
    const args = judgment(outcome, saved.record.evidence[0]!.id);
    const result = await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, args);
    assert.equal(result.evaluation.workspaceId, workspace.id);
    assert.equal("projectId" in result.evaluation, false);
    // snapshotは全TargetのSummary・EvidenceをProject別に保持する。
    assert.deepEqual(result.evaluation.snapshot.targets.map(target => [target.projectId, target.execution.executionCursor]), [[a.id, 10], [kit.b.id, 4]]);
    await assert.rejects(direction.recordOutcomeEvaluationUseCase.execute(other.id, "evaluator", outcome.id, args), { code: "NOT_FOUND" });
    assert.deepEqual(await database.selectFrom("outcome_evaluation").selectAll().where("workspace_id", "=", other.id).execute(), []);
    const activity = await database.selectFrom("activity").selectAll().where("type", "=", "outcome.evaluated").executeTakeFirstOrThrow();
    assert.equal(activity.workspace_id, workspace.id);
    assert.equal(activity.project_id, null);
    const events = await direction.fetchRuntimeEventsUseCase.execute("runtime", workspace.id);
    const event = events.events.find(item => item.type === "outcome_evaluated")!;
    assert.equal(event.evaluationId, result.evaluation.id);
    assert.equal(event.correlationId, input.correlationId);
    await assert.rejects(direction.ackRuntimeEventUseCase.execute("runtime", other.id, { eventId: event.id, attemptId: "ack", outcome: "processed" }), { code: "NOT_FOUND" });
    const ackInput = { eventId: event.id, attemptId: "ack", outcome: "retryable_failure", reason: "retry" };
    const ack = await direction.ackRuntimeEventUseCase.execute("runtime", workspace.id, ackInput);
    const eventRow = await database.selectFrom("runtime_event").selectAll().where("id", "=", event.id).executeTakeFirstOrThrow();
    await assert.rejects(database.insertInto("runtime_event_ack_attempt").values({ workspace_id: other.id, event_sequence: eventRow.sequence, consumer_id: "other", attempt_id: "bad", input_json: "{}", result_json: "{}", created_at: 1 }).execute(), /FOREIGN KEY/);
    await assert.rejects(database.updateTable("outcome_evaluation").set({ workspace_id: other.id }).execute(), /FOREIGN KEY/);
    await database.destroy();
    database = createDatabase(path);
    await initializeSchema(database);
    await initializeSchema(database);
    const reopened = createApplicationServices(database).workspaceDirection;
    assert.deepEqual(await reopened.getExecutionSummaryUseCase.execute(workspace.id, a.id, outcome.id), saved.record);
    assert.deepEqual(await reopened.listOutcomeEvaluationsUseCase.execute(workspace.id, outcome.id), [result.evaluation]);
    assert.deepEqual((await reopened.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, args)).evaluation, result.evaluation);
    assert.deepEqual((await reopened.ackRuntimeEventUseCase.execute("runtime", workspace.id, ackInput)).delivery, ack.delivery);
    assert.equal((await reopened.fetchRuntimeEventsUseCase.execute("runtime", workspace.id)).events.find(item => item.id === event.id)!.retryCount, 1);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(database)).rows, []);
  } finally { await database?.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Evaluation, event and canonical Activity roll back together; archived Workspace rejects new evaluations and execution", async () => {
  const { database, direction, repository, input, workspace, a, b, outcome } = await setup();
  try {
    const saved = await repository.record(workspace.id, a.id, input);
    if (saved.kind !== "recorded") throw new Error("record missing");
    await repository.record(workspace.id, b.id, input);
    const args = judgment(outcome, saved.record.evidence[0]!.id);
    await sql`create trigger reject_evaluation_activity before insert on activity when new.type = 'outcome.evaluated' begin select raise(abort, 'activity rejected'); end`.execute(database);
    await assert.rejects(direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, args), /activity rejected/);
    assert.deepEqual(await database.selectFrom("outcome_evaluation").selectAll().execute(), []);
    assert.deepEqual(await database.selectFrom("runtime_event").selectAll().where("event_type", "=", "outcome_evaluated").execute(), []);
    await new SQLiteWorkspaceRepository(asOrganizationDatabase(database)).archive(workspace.id, "Archive");
    await assert.rejects(direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, args), { code: "CONFLICT", details: { workspaceStatus: "archived" } });
    assert.deepEqual(await repository.record(workspace.id, a.id, input), { kind: "workspace_archived" });
    assert.deepEqual(await repository.find(workspace.id, a.id, outcome.id), saved.record);
  } finally { await database.destroy(); }
});

test("Outcome becomes evaluable only when every Target reflected a finished Execution, and the Evaluator gets all Targets", async () => {
  const { database, services, direction, repository, input, workspace, a, b, outcome } = await setup();
  try {
    const evaluate = (evidenceId: string, requestKey: string) =>
      direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, judgment(outcome, evidenceId, requestKey));
    const context = () => direction.getEvaluatorContextUseCase.execute("evaluator", workspace.id, outcome.id);
    const listed = () => direction.listOutcomeTargetExecutionsUseCase.execute(workspace.id, outcome.id);

    // 還流前: 全Targetが未還流。
    assert.deepEqual((await context()).evaluability, {
      status: "awaiting_execution",
      unfinishedTargets: [
        { projectId: a.id, projectStatus: "active", reason: "not_reflected" },
        { projectId: b.id, projectStatus: "active", reason: "not_reflected" },
      ],
    });
    // Aだけ完了（Bは未還流）: 一部のProjectの完了だけでは評価しない。
    const first = await repository.record(workspace.id, a.id, input);
    if (first.kind !== "recorded") throw new Error("record missing");
    const evidenceA = first.record.evidence[0]!.id;
    await assert.rejects(evaluate(evidenceA, "partial"), { code: "CONFLICT", details: { reason: "awaiting_execution", unfinishedProjectIds: b.id } });
    // Bが還流してもincompleteの間は評価しない。
    await repository.record(workspace.id, b.id, { ...input, state: "incomplete", executionCursor: 3, changeCursor: 3 });
    assert.deepEqual((await listed()).evaluability.unfinishedTargets, [{ projectId: b.id, projectStatus: "active", reason: "incomplete" }]);
    await assert.rejects(evaluate(evidenceA, "incomplete"), { code: "CONFLICT", details: { reason: "awaiting_execution", unfinishedProjectIds: b.id } });

    // 全Targetが完了: Evaluator Contextは全TargetのSummary・EvidenceをProject別に持ち、評価可能。
    const second = await repository.record(workspace.id, b.id, { ...input, executionCursor: 5, changeCursor: 5,
      evidence: [{ kind: "ci", uri: "https://ci.example.com/b", versionHash: null, observedAt: 1 }] });
    if (second.kind !== "recorded") throw new Error("record missing");
    const evidenceB = second.record.evidence.find(item => item.kind === "ci")!.id;
    const ready = await context();
    assert.deepEqual(ready.evaluability, { status: "evaluable", unfinishedTargets: [] });
    assert.deepEqual(ready.targets.map(target => [target.projectId, target.projectStatus, target.execution?.summary.executionCursor]), [[a.id, "active", 10], [b.id, "active", 5]]);
    assert.deepEqual((await listed()).evaluability, ready.evaluability);
    // BのEvidenceを根拠にでき、snapshotはTargetごとのSummary・Evidenceを合算せずに保持する。
    const evaluated = await evaluate(evidenceB, "all-targets");
    assert.deepEqual(evaluated.evaluation.snapshot.targets.map(target => [target.projectId, target.execution.state, target.evidence.map(item => item.id)]), [
      [a.id, "accepted", first.record.evidence.map(item => item.id)],
      [b.id, "accepted", second.record.evidence.map(item => item.id)],
    ]);

    // archive前に完了を還流したTargetは、Project archiveだけを理由に評価から除外しない。
    await services.archiveProjectUseCase.execute(b.id, { reason: "Done" });
    const archivedDone = await context();
    assert.deepEqual(archivedDone.evaluability, { status: "evaluable", unfinishedTargets: [] });
    assert.deepEqual(archivedDone.targets.map(target => [target.projectId, target.projectStatus]), [[a.id, "active"], [b.id, "archived"]]);
    const afterArchive = await evaluate(evidenceB, "archived-done");
    assert.deepEqual(afterArchive.evaluation.snapshot.targets.map(target => [target.projectId, target.projectStatus]), [[a.id, "active"], [b.id, "archived"]]);
    assert.equal(afterArchive.evaluation.criteria[0]!.evidenceIds[0], evidenceB);
  } finally { await database.destroy(); }
});

test("Archived Target with unfinished Execution and an Outcome without Targets go back to the Strategist", async () => {
  const { database, services, direction, repository, input, workspace, intent, a, b, outcome } = await setup();
  try {
    const context = (outcomeId: string) => direction.getEvaluatorContextUseCase.execute("evaluator", workspace.id, outcomeId);
    const evaluate = (outcomeId: string, args: ReturnType<typeof judgment>) =>
      direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcomeId, args);

    // Targetなし: 評価せず、Strategistの判断へ戻す。
    const untargeted = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, {
      title: "Untargeted", description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }],
    });
    assert.deepEqual([(await context(untargeted.id)).targets, (await context(untargeted.id)).evaluability], [[], { status: "no_targets", unfinishedTargets: [] }]);
    await assert.rejects(evaluate(untargeted.id, { ...judgment(untargeted, "none", "untargeted"), criteria: [{ criterionId: untargeted.successCriteria[0]!.id, verdict: "insufficient_evidence", rationale: "None", evidenceIds: [] }] }),
      { code: "CONFLICT", details: { reason: "no_targets", unfinishedProjectIds: "" } });

    // archivedのTarget Bに未完了（incomplete）が残る: 還流待ちに留めず、Strategistの再計画対象。
    const saved = await repository.record(workspace.id, a.id, input);
    if (saved.kind !== "recorded") throw new Error("record missing");
    await repository.record(workspace.id, b.id, { ...input, state: "incomplete", executionCursor: 3, changeCursor: 3 });
    await services.archiveProjectUseCase.execute(b.id, { reason: "Stopped" });
    assert.deepEqual((await context(outcome.id)).evaluability, {
      status: "replan_required",
      unfinishedTargets: [{ projectId: b.id, projectStatus: "archived", reason: "incomplete" }],
    });
    await assert.rejects(evaluate(outcome.id, judgment(outcome, saved.record.evidence[0]!.id, "replan")),
      { code: "CONFLICT", details: { reason: "replan_required", unfinishedProjectIds: b.id } });
    // 保存済みのSummary・Evidenceは保持する。
    assert.equal((await repository.find(workspace.id, b.id, outcome.id))!.summary.state, "incomplete");

    // StrategistがBをTargetから外すと、Aだけで評価可能になる。Bの記録は評価の入力にしない。
    await direction.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id);
    const replanned = await context(outcome.id);
    assert.deepEqual([replanned.evaluability.status, replanned.targets.map(target => target.projectId)], ["evaluable", [a.id]]);
    const bEvidence = (await repository.find(workspace.id, b.id, outcome.id))!.evidence[0]!.id;
    await assert.rejects(evaluate(outcome.id, judgment(outcome, bEvidence, "removed-target")), { code: "VALIDATION_ERROR" });
    const result = await evaluate(outcome.id, judgment(outcome, saved.record.evidence[0]!.id, "after-replan"));
    assert.deepEqual(result.evaluation.snapshot.targets.map(target => target.projectId), [a.id]);

    // archivedのTarget Bが未還流でも同じくStrategistへ戻す。
    const next = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, {
      title: "Next", description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }],
    });
    await direction.setOutcomeTargetProjectUseCase.execute(workspace.id, next.id, a.id);
    await assert.rejects(direction.setOutcomeTargetProjectUseCase.execute(workspace.id, next.id, b.id), { code: "CONFLICT" });
  } finally { await database.destroy(); }
});

import {
  RecordOutcomeEvaluationUseCase, SQLiteOutcomeEvaluationRepository, SQLiteOutcomeRepository, SQLiteOutcomeTargetProjectRepository,
} from "@compass/direction";
import { directionChangeObserver } from "../src/infrastructure/repository/contextAdapters.ts";

/** Targetを読んだ直後（保存の前）に、1回だけ別の操作を割り込ませる評価のUseCase。 */
const evaluationRacing = (database: ReturnType<typeof createDatabase>, interleave: () => Promise<unknown>) => {
  const direction = asDirectionDatabase(database);
  const targets = new SQLiteOutcomeTargetProjectRepository(direction, directionProjectReaders, directionWorkspaceReaders);
  let pending: (() => Promise<unknown>) | null = interleave;
  const racingTargets = {
    listByOutcome: async (workspaceId: string, outcomeId: string) => {
      const read = await targets.listByOutcome(workspaceId, outcomeId);
      const run = pending;
      pending = null;
      if (run) await run();
      return read;
    },
  };
  return new RecordOutcomeEvaluationUseCase(
    new SQLiteWorkspaceRepository(asOrganizationDatabase(database)),
    new SQLiteOutcomeRepository(direction, directionWorkspaceReaders, directionChangeObserver),
    racingTargets,
    new SQLiteOutcomeExecutionRepository(direction, directionProjectReaders, directionWorkspaceReaders),
    new SQLiteOutcomeEvaluationRepository(direction, directionWorkspaceReaders, directionProjectReaders, directionChangeObserver),
    () => 100,
  );
};

const evaluationRecords = async (database: ReturnType<typeof createDatabase>) => [
  (await database.selectFrom("outcome_evaluation").selectAll().execute()).length,
  (await database.selectFrom("runtime_event").selectAll().where("event_type", "=", "outcome_evaluated").execute()).length,
  (await database.selectFrom("activity").selectAll().where("type", "=", "outcome.evaluated").execute()).length,
];

test("Target and Execution changes racing an evaluation never save an evaluation of only some Targets", async () => {
  const { database, direction, repository, input, workspace, intent, a, b, outcome } = await setup();
  try {
    const saved = await repository.record(workspace.id, a.id, input);
    if (saved.kind !== "recorded") throw new Error("record missing");
    const evidenceA = saved.record.evidence[0]!.id;
    const created = async (title: string) => direction.createOutcomeUseCase.execute(workspace.id, intent.id, {
      title, description: "Result", rationale: "Reason", successCriteria: [{ description: "Done", measurement: "Check" }],
    });

    // Aだけが完了還流した状態で評価を始め、読取の直後に未還流のBがTargetへ加わる: 保存せず、読み直してBの還流待ちで拒否する。
    const added = await created("Added");
    await direction.setOutcomeTargetProjectUseCase.execute(workspace.id, added.id, a.id);
    const addedA = await repository.record(workspace.id, a.id, { ...input, outcomeId: added.id, correlationId: `outcome:${added.id}` });
    if (addedA.kind !== "recorded") throw new Error("record missing");
    const raceAdd = evaluationRacing(database, () => direction.setOutcomeTargetProjectUseCase.execute(workspace.id, added.id, b.id));
    await assert.rejects(raceAdd.execute(workspace.id, "evaluator", added.id, judgment(added, addedA.record.evidence[0]!.id, "race-add")),
      { code: "CONFLICT", details: { reason: "awaiting_execution", unfinishedProjectIds: b.id } });
    assert.deepEqual(await evaluationRecords(database), [0, 0, 0]);

    // 全Targetが完了した後、読取の直後にBのExecutionがincompleteへ進む: 評価しない。
    await repository.record(workspace.id, b.id, input);
    const raceIncomplete = evaluationRacing(database, () =>
      repository.record(workspace.id, b.id, { ...input, state: "incomplete", executionCursor: 20, changeCursor: 20 }));
    await assert.rejects(raceIncomplete.execute(workspace.id, "evaluator", outcome.id, judgment(outcome, evidenceA, "race-incomplete")),
      { code: "CONFLICT", details: { reason: "awaiting_execution", unfinishedProjectIds: b.id } });
    assert.deepEqual(await evaluationRecords(database), [0, 0, 0]);

    // Bが完了へ戻った後、読取の直後にBがTargetから外れる: 読み直した全Target（Aだけ）で評価し、snapshotにBを含めない。
    await repository.record(workspace.id, b.id, { ...input, executionCursor: 25, changeCursor: 25 });
    const raceRemove = evaluationRacing(database, () => direction.unsetOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, b.id));
    const removed = await raceRemove.execute(workspace.id, "evaluator", outcome.id, judgment(outcome, evidenceA, "race-remove"));
    assert.deepEqual([removed.recorded, removed.evaluation.snapshot.targets.map(target => target.projectId)], [true, [a.id]]);
    assert.deepEqual(await evaluationRecords(database), [1, 1, 1]);

    // 読取の直後にAのSummaryが進む: 古いsnapshotは保存せず、読み直した最新のSummaryで1件だけ保存する。
    const raceSummary = evaluationRacing(database, () =>
      repository.record(workspace.id, a.id, { ...input, executionCursor: 30, changeCursor: 30 }));
    const refreshed = await raceSummary.execute(workspace.id, "evaluator", outcome.id, judgment(outcome, evidenceA, "race-summary"));
    assert.deepEqual([refreshed.recorded, refreshed.evaluation.snapshot.targets.map(target => target.execution.executionCursor)], [true, [30]]);
    assert.deepEqual(await evaluationRecords(database), [2, 2, 2]);
    // 再送は保存済みの評価を返し、新しい評価・イベント・Activityを作らない。
    const replayed = await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, judgment(outcome, evidenceA, "race-summary"));
    assert.deepEqual([replayed.recorded, replayed.evaluation.id], [false, refreshed.evaluation.id]);
    assert.deepEqual(await evaluationRecords(database), [2, 2, 2]);
  } finally { await database.destroy(); }
});

import { createSignedInApp, seedLegacyProjectGrant } from "./support/humanSession.ts";

test("Execution Summary stays Project-scoped while Evaluation and Runtime events require Workspace authorization", async () => {
  const { database, services, workspace, a, b, outcome } = await setup();
  try {
    const app = await createSignedInApp(database, services);
    for (const role of ["runtime", "evaluator"] as const) {
      await seedLegacyProjectGrant(database, a.id, role, role);
    }
    const call = async (name: string, args: object, role: string) => {
      const response = await app.request("/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${role}`, "X-Compass-Active-Role": role },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
      });
      const line = (await response.text()).split("\n").find(item => item.startsWith("data: "));
      assert.ok(line);
      return JSON.parse(line.slice(6)).result as { isError?: boolean; structuredContent: Record<string, any> };
    };
    // Execution SummaryはProject固有の記録。Project Grantで、そのProjectの分だけ読める。
    assert.equal((await call("get_outcome_execution_summary", { projectId: b.id, outcomeId: outcome.id }, "runtime")).structuredContent.error.code, "FORBIDDEN");
    assert.equal((await call("get_outcome_execution_summary", { projectId: a.id, outcomeId: outcome.id }, "runtime")).isError, undefined);
    // Evaluation・Runtime eventはWorkspace所有。Project Grant・trusted-localのAgent名からは継承しない。
    for (const [name, role] of [["fetch_runtime_events", "runtime"], ["get_evaluator_context", "evaluator"]] as const) {
      const denied = await call(name, { workspaceId: workspace.id, outcomeId: outcome.id }, role);
      assert.equal(denied.structuredContent.error.code, "FORBIDDEN", name);
      assert.equal(JSON.stringify(denied).includes(outcome.title), false);
      assert.equal((await call(name, { projectId: a.id, outcomeId: outcome.id }, role)).isError, true, `${name} has no projectId input`);
    }
    assert.equal((await app.request(`/api/projects/${a.id}/outcomes/${outcome.id}/execution-summary`)).status, 200);
    assert.equal((await app.request(`/api/projects/${a.id}/outcomes/${outcome.id}/evaluations`)).status, 404);
    assert.equal((await app.request(`/api/workspaces/${workspace.id}/outcomes/${outcome.id}/evaluations`)).status, 200);
    assert.equal((await app.request(`/api/projects/${a.id}/runtime-events`, { headers: { Authorization: "Bearer runtime" } })).status, 404);
    assert.equal((await app.request(`/api/workspaces/${workspace.id}/runtime-events`, { headers: { Authorization: "Bearer runtime" } })).status, 403);
  } finally { await database.destroy(); }
});
