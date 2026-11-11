import assert from "node:assert/strict";
import test from "node:test";
import { CoordinationError, KyselyWorkStore, TaskCoordinationService, type DirectionReferenceLookupPort, type TaskRecord, type StoryRecord } from "@compass/work";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asWorkDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { workExternalReaders } from "../src/infrastructure/repository/workReaders.ts";
import { D1WorkStore } from "../src/infrastructure/repository/d1/D1WorkStore.ts";
import { planD1WorkActivity } from "../src/infrastructure/repository/d1/planD1WorkActivity.ts";
import { D1WritePlan } from "../src/infrastructure/database/d1/D1WritePlan.ts";
import { D1InteractiveTransactionUnsupportedError } from "../src/infrastructure/database/d1/D1Dialect.ts";

const noDirection: DirectionReferenceLookupPort = { getProjectExecutionContext: async () => assert.fail("Unexpected Direction read"), getOutcomeSnapshot: async () => assert.fail("Unexpected Direction read") };
const setup = async () => {
  const context = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(context.binding);
    const organization = createD1OrganizationInfrastructure(context.database, context.binding, activityActorContext);
    const project = await organization.projectRepository.create({ name: "Product", description: null, mission: "Goal", vision: null,
      principles: [], constraints: [], repositories: [], resources: [] });
    const store = new D1WorkStore(asWorkDatabase(context.database), context.binding, workExternalReaders, planD1WorkActivity);
    let now = 1000;
    const task: TaskRecord = { id: "task", project_id: project.id, story_id: null, title: "Task", description: null, status: "todo",
      assignee: null, reject_reason: null, resume_source_status: null, sort_order: 1, created_at: now, updated_at: now, task_key: null };
    const service = new TaskCoordinationService(store, noDirection, () => now, 1000);
    for (const [principal_id, role] of [["worker", "worker"], ["other", "worker"], ["reviewer", "reviewer"], ["manager", "manager"]]) {
      await context.database.insertInto("project_grant").values({ project_id: project.id, principal_id: principal_id!, role: role!, created_at: now }).execute();
    }
    return { ...context, ...organization, project, store, service, task, setNow: (at: number) => { now = at; } };
  } catch (error) { await context.runtime.dispose(); throw error; }
};

test("D1 Work transaction reads staged inserts, joins, aggregates, updates and deletes before one commit", async () => {
  const { runtime, database, project, store, task } = await setup();
  try {
    const story: StoryRecord = { id: "story", project_id: project.id, title: "O'Brien\n日本語", description: null, status: "todo", sort_order: 1, created_at: 1000, updated_at: 1000,
      outcome_ref: "outcome", origin_decision_id: null, success_criteria_snapshot: null, constraints_snapshot: null, repository_snapshot: null, correlation_id: "correlation" };
    await store.transaction(async (tx) => {
      await tx.insertStory(story);
      await tx.insertTask({ ...task, story_id: story.id });
      assert.equal((await database.selectFrom("task").selectAll().execute()).length, 0);
      assert.equal((await tx.findStoryByCorrelation(project.id, "correlation"))?.title, story.title);
      assert.equal((await tx.listTasks(project.id)).length, 1);
      const ids = [story.id, ...Array.from({ length: 105 }, (_, index) => `missing-${index}`)];
      assert.equal((await tx.listTasksOfStories(project.id, ids)).length, 1);
      assert.equal((await tx.listStoriesByOutcomeProjects([{ projectId: project.id, outcomeId: "outcome" }, ...ids.map((id) => ({ projectId: project.id, outcomeId: id }))])).length, 1);
      assert.deepEqual(await tx.countTasksOfStories([story.id]), [{ story_id: story.id, status: "todo", count: 1 }]);
      await tx.updateTask(task.id, { status: "doing", description: "Changed\n日本語" });
      assert.equal((await tx.findTask(task.id))?.status, "doing");
      assert.equal(await tx.hasUnsettledTask(story.id), true);
      assert.equal(await tx.updateStoryStatusIf(story.id, "todo", "doing", 1001), true);
      assert.equal(await tx.updateStoryStatusIf(story.id, "todo", "done", 1001), false);
      assert.equal((await tx.findStory(story.id))?.status, "doing");
      await tx.insertTaskComment({ id: "comment", task_id: task.id, body: "Memo", author: null, principal_id: "worker", claim_id: "claim", created_at: 1000 });
      assert.equal(await tx.hasClaimComment(task.id, "claim", "worker"), true);
      assert.equal((await tx.listTaskComments(task.id)).length, 1);
      const wait = { task_id: task.id, project_id: project.id, principal_id: "worker", role: "worker" as const, phase: "work" as const,
        consultations: "[]", requirement_version: "v1", runtime: "{}", state: "waiting" as const, failure_reason: null, created_at: 1000, updated_at: 1000 };
      await tx.saveConsultationWait(wait);
      assert.equal((await tx.findConsultationWait(task.id))?.state, "waiting");
      await tx.deleteConsultationWait(task.id);
      assert.equal(await tx.findConsultationWait(task.id), null);
      const cursor = await tx.appendChange({ project_id: project.id, type: "TASK_CREATED", entity_id: task.id, principal_id: "manager", claim_id: null, payload: "{}", occurred_at: 1000 });
      assert.equal(await tx.maxChangeCursor(project.id), cursor);
      assert.equal((await tx.listEntityChanges(project.id, task.id)).length, 1);
      assert.equal((await tx.listEntityCorrelations(project.id, [task.id, ...ids])).length, 2);
      assert.equal(await tx.maxChangeCursor(project.id, [task.id, ...ids]), cursor);
    });
    assert.equal((await store.findTask(task.id))?.description, "Changed\n日本語");
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Work stages PR updates, Publication sequence and composite revision keys in the same Unit of Work", async () => {
  const { runtime, database, project, store, task } = await setup();
  try {
    await store.insertTask(task);
    await store.transaction(async (tx) => {
      await tx.insertTaskPullRequest({ id: "pr", task_id: task.id, project_id: project.id, repository_id: "repository", repository: "example/source", number: 1,
        sequence: 1, url: "https://github.com/example/source/pull/1", state: "open", draft: 0, head_branch: "feature", head_sha: "a".repeat(40), base_branch: "main",
        merge_sha: null, author: "author", work_claim_id: "claim", principal_id: "worker", verified_at: 1000, reviewed_head_sha: null, review_comment_id: null,
        review_comment_url: null, accepted_merge_sha: null, acceptance_evidence: null, created_at: 1000, updated_at: 1000 });
      await tx.updateTaskPullRequest("pr", { state: "merged", merge_sha: "b".repeat(40), updated_at: 1001 });
      assert.equal((await tx.findPullRequestByNumber("example/source", 1))?.state, "merged");
      assert.equal((await tx.listTaskPullRequests(task.id)).length, 1);
      assert.equal((await tx.listProjectPullRequests(project.id)).length, 1);
      const sequence = await tx.nextPublicationSequence(project.id);
      assert.equal(sequence, 1);
      const publication = { id: "publication", project_id: project.id, repository_id: "repository", target: "production", target_url: null, revision: "b".repeat(40),
        method: "manual", evidence: "[]", observed_at: 1000, received_at: 1000, sequence, principal_id: "runtime" };
      await tx.insertPublication(publication, [{ publication_id: publication.id, commit_sha: "a".repeat(40), relation: "included" },
        { publication_id: publication.id, commit_sha: "c".repeat(40), relation: "not_included" }]);
      assert.equal(await tx.nextPublicationSequence(project.id), 2);
      assert.equal((await tx.findPublication(publication))?.id, publication.id);
      assert.equal((await tx.listPublicationRevisions(project.id)).length, 2);
      await tx.transaction(async (nested) => assert.equal((await nested.listPublications(project.id)).length, 1));
    });
    assert.equal((await store.listTaskPullRequests(task.id))[0]?.state, "merged");
    assert.equal((await store.listPublicationRevisions(project.id)).length, 2);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Work uses the existing guarded Worker, Reviewer and Manager lifecycle and replays receipts", async () => {
  const { runtime, database, store, service, task } = await setup();
  try {
    await store.insertStory({ id: "story", project_id: task.project_id, title: "Story", description: null, status: "todo", sort_order: 1, created_at: 1000, updated_at: 1000,
      outcome_ref: null, origin_decision_id: null, success_criteria_snapshot: null, constraints_snapshot: null, repository_snapshot: null, correlation_id: null });
    await store.insertTask({ ...task, story_id: "story" });
    for (const role of ["reviewer", "manager"]) await database.insertInto("project_grant").values({ project_id: task.project_id, principal_id: "worker", role, created_at: 1000 }).execute();
    const [claim, replayedClaim] = await Promise.all([service.claimTask("worker", task.id, "claim-work"), service.claimTask("worker", task.id, "claim-work")]);
    assert.deepEqual(replayedClaim, claim);
    assert.deepEqual(await service.claimTask("worker", task.id, "claim-work"), claim);
    await service.addTaskComment("worker", task.id, claim.claimId, "Implemented and verified", "comment-work");
    await service.completeTask("worker", task.id, claim.claimId, "complete-work");
    await assert.rejects(service.claimReview("worker", task.id, "self-review"), (error: unknown) => error instanceof CoordinationError && error.code === "SELF_REVIEW_NOT_ALLOWED");
    const review = await service.claimReview("reviewer", task.id, "claim-review");
    await service.reviewedTask("reviewer", task.id, review.claimId, "review-task");
    await assert.rejects(service.claimAcceptance("worker", task.id, "self-accept"), (error: unknown) => error instanceof CoordinationError && error.code === "SELF_ACCEPTANCE_NOT_ALLOWED");
    const accept = await service.claimAcceptance("manager", task.id, "claim-accept");
    await service.acceptTask("manager", task.id, accept.claimId, "accept-task");
    assert.equal((await store.findTask(task.id))?.status, "accepted");
    assert.equal((await store.findStory("story"))?.status, "done");
    const before = (await store.listEntityChanges(task.project_id, task.id)).length;
    await service.acceptTask("manager", task.id, accept.claimId, "accept-task");
    assert.equal((await store.listEntityChanges(task.project_id, task.id)).length, before);
    assert.equal((await database.selectFrom("activity").selectAll().where("type", "=", "task.accepted").execute()).length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Work expires and replaces a Claim in one plan and reads the new active owner", async () => {
  const { runtime, database, store, service, task, setNow } = await setup();
  try {
    await store.insertTask(task);
    const first = await service.claimTask("worker", task.id, "first");
    setNow(1500);
    assert.equal((await service.renewClaim("worker", first.claimId)).expiresAt, 2500);
    setNow(2501);
    const second = await service.claimTask("other", task.id, "second");
    assert.notEqual(second.claimId, first.claimId);
    assert.equal((await store.findClaim(first.claimId))?.state, "expired");
    assert.equal((await store.findActiveClaim(task.id))?.principal_id, "other");
    await service.releaseClaim("other", second.claimId, "Release", "release-second");
    assert.equal((await store.findClaim(second.claimId))?.state, "released");
    assert.equal((await store.findTask(task.id))?.status, "todo");
    assert.notEqual((await service.claimTask("worker", task.id, "third")).claimId, second.claimId);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Work validates Grant revocation at commit and rolls back failed Receipt persistence", async () => {
  const { runtime, binding, database, project, store, service, task } = await setup();
  try {
    await store.insertTask(task);
    let inject = true;
    const racing = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        if (inject) { inject = false; await database.deleteFrom("project_grant").where("project_id", "=", project.id).where("principal_id", "=", "worker").execute(); }
        return target.batch(statements);
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const raced = new TaskCoordinationService(new D1WorkStore(asWorkDatabase(database), racing, workExternalReaders, planD1WorkActivity), noDirection, () => 1000, 1000);
    await assert.rejects(raced.claimTask("worker", task.id, "revoked"), (error: unknown) => error instanceof CoordinationError && error.code === "FORBIDDEN");
    assert.equal((await store.findTask(task.id))?.status, "todo");
    assert.equal(await store.findActiveClaim(task.id), null);
    await binding.prepare("CREATE TRIGGER reject_work_receipt BEFORE INSERT ON command_receipt BEGIN SELECT RAISE(ABORT, 'receipt failure'); END;").run();
    await assert.rejects(service.claimTask("other", task.id, "failed-receipt"), /receipt failure/);
    assert.equal((await store.findTask(task.id))?.status, "todo");
    for (const table of ["task_claim", "change_log", "activity", "command_receipt"] as const) assert.equal((await database.selectFrom(table).selectAll().execute()).length, 0);
    await binding.prepare("DROP TRIGGER reject_work_receipt").run();
    assert.equal((await service.claimTask("other", task.id, "failed-receipt")).taskStatus, "doing");
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 Work does not retry unknown commit outcomes and recovers them using the same Receipt ID", async () => {
  const { runtime, binding, database, store, service, task } = await setup();
  try {
    await store.insertTask(task);
    let calls = 0;
    const uncertain = new Proxy(binding, { get(target, property) {
      if (property === "batch") return async (statements: Parameters<typeof binding.batch>[0]) => {
        calls++; await target.batch(statements); throw new Error("Transport closed after commit");
      };
      const value = Reflect.get(target, property); return typeof value === "function" ? value.bind(target) : value;
    } });
    const failed = new TaskCoordinationService(new D1WorkStore(asWorkDatabase(database), uncertain, workExternalReaders, planD1WorkActivity), noDirection, () => 1000, 1000);
    await assert.rejects(failed.claimTask("worker", task.id, "uncertain"), /Transport closed/);
    assert.equal(calls, 1);
    const recovered = await service.claimTask("worker", task.id, "uncertain");
    assert.equal(recovered.claimId, (await store.findActiveClaim(task.id))?.id);
    assert.equal((await database.selectFrom("command_receipt").selectAll().execute()).length, 1);
    assert.equal((await database.selectFrom("activity").selectAll().execute()).length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});

test("D1 planned reads reject direct mutations and callback DB transactions", async () => {
  const { runtime, binding, database, task, store } = await setup();
  const plan = new D1WritePlan(binding, { task: { key: ["id"] } });
  try {
    await assert.rejects(plan.database.insertInto("task").values(task).execute(), /cannot execute direct SQL mutations/);
    await assert.rejects(KyselyWorkStore.prototype.insertTask.call(store, task), /cannot execute direct SQL mutations/);
    await assert.rejects(plan.database.transaction().execute(async () => {}), D1InteractiveTransactionUnsupportedError);
    assert.equal((await database.selectFrom("task").selectAll().execute()).length, 0);
  } finally { await plan.dispose(); await database.destroy(); await runtime.dispose(); }
});

test("D1 Work concurrent claims produce one owner and one business conflict", async () => {
  const { runtime, database, store, service, task } = await setup();
  try {
    await store.insertTask(task);
    const replies = await Promise.allSettled([service.claimTask("worker", task.id, "claim-a"), service.claimTask("other", task.id, "claim-b")]);
    assert.equal(replies.filter(({ status }) => status === "fulfilled").length, 1);
    const failed = replies.find((reply) => reply.status === "rejected");
    assert.ok(failed?.status === "rejected" && failed.reason instanceof CoordinationError && failed.reason.code === "CLAIM_CONFLICT");
    assert.equal((await store.listActiveClaims(task.project_id)).length, 1);
    assert.equal((await database.selectFrom("command_receipt").selectAll().execute()).length, 1);
  } finally { await database.destroy(); await runtime.dispose(); }
});
