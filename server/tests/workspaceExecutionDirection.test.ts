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
    // 全Target評価は後続Task。現行の単一source snapshotで複数Projectの片方だけを評価しない。
    await assert.rejects(direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id,
      judgment(outcome, first.record.evidence[0]!.id)), { code: "CONFLICT", details: { reason: "multi_project_evaluation_required" } });
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
    const args = judgment(outcome, saved.record.evidence[0]!.id);
    const result = await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, "evaluator", outcome.id, args);
    assert.equal(result.evaluation.workspaceId, workspace.id);
    assert.equal("projectId" in result.evaluation, false);
    assert.equal(result.evaluation.snapshot.execution.projectId, a.id);
    assert.equal(result.evaluation.snapshot.execution.workspaceId, workspace.id);
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
  const { database, direction, repository, input, workspace, a, outcome } = await setup();
  try {
    const saved = await repository.record(workspace.id, a.id, input);
    if (saved.kind !== "recorded") throw new Error("record missing");
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

import { createSignedInApp } from "./support/humanSession.ts";

test("Project Web/API/MCP entries authorize before rejecting shared Workspace Evaluation and Runtime access", async () => {
  const { database, services, a, b, outcome } = await setup();
  try {
    const app = await createSignedInApp(database, services);
    for (const role of ["runtime", "evaluator"] as const) {
      await services.grantProjectRoleUseCase.execute(a.id, { principalId: role, role });
    }
    const call = async (name: string, projectId: string, role: string) => {
      const response = await app.request("/mcp", {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${role}`, "X-Compass-Active-Role": role },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: { projectId, outcomeId: outcome.id } } }),
      });
      const line = (await response.text()).split("\n").find(item => item.startsWith("data: "));
      assert.ok(line);
      return JSON.parse(line.slice(6)).result.structuredContent;
    };
    for (const [name, role] of [["fetch_runtime_events", "runtime"], ["get_outcome_execution_summary", "runtime"], ["get_evaluator_context", "evaluator"]]) {
      const denied = await call(name!, b.id, role!);
      assert.equal(denied.error.code, "FORBIDDEN");
      const shared = await call(name!, a.id, role!);
      assert.equal(shared.error.reason, "workspace_direction_required");
      assert.equal(JSON.stringify(shared).includes(outcome.id), false);
    }
    for (const suffix of [`outcomes/${outcome.id}/execution-summary`, `outcomes/${outcome.id}/evaluations`]) {
      assert.equal((await app.request(`/api/projects/${a.id}/${suffix}`)).status, 409);
    }
    assert.equal((await app.request(`/api/projects/${b.id}/runtime-events`, { headers: { Authorization: "Bearer runtime" } })).status, 403);
    assert.equal((await app.request(`/api/projects/${a.id}/runtime-events`, { headers: { Authorization: "Bearer runtime" } })).status, 409);
  } finally { await database.destroy(); }
});
