import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import { CoordinationError } from "../src/application/error/CoordinationError.ts";
import type { DirectionReferenceLookupPort } from "../src/application/port/DirectionReferenceLookupPort.ts";
import { TaskCoordinationService } from "../src/application/service/execution/TaskCoordinationService.ts";
import { ProjectRole } from "../src/constants/ProjectRole.ts";
import { TaskStatus } from "../src/domain/model/execution/TaskStatus.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

/**
 * 旧Wachaの`TaskCoordinationService`の回帰テスト（Role Grant・排他Claim・状態遷移・Comment・Change Log・requestId冪等性）を、
 * Compassの統合DB・DI方式へ移した。期待値は旧Wachaのものを変えていない。
 * Directionを参照しない旧Wachaの操作では読取ポートは使われないため、呼ばれたら失敗するstubにしている。
 */
const noDirectionReferences: DirectionReferenceLookupPort = {
  getOutcomeSnapshot: async () => assert.fail("Directionを参照しない操作でOutcomeを読んではならない"),
  getRepositoryReference: async () => assert.fail("Directionを参照しない操作でRepositoryを読んではならない"),
};

let database = createDatabase(":memory:");
let services = createApplicationServices(database);
let now = 1_000;
let service = new TaskCoordinationService(database, noDirectionReferences, () => now, 1_000);

beforeEach(async () => {
  await database.destroy();
  database = createDatabase(":memory:");
  await initializeSchema(database);
  services = createApplicationServices(database);
  now = 1_000;
  service = new TaskCoordinationService(database, noDirectionReferences, () => now, 1_000);
});

const createProject = async (name = "Coordination") =>
  services.createProjectUseCase.execute({ name, mission: "Keep execution guarded" });

/** 旧Wachaのテストと同じく、Change Logを増やさずにTaskを直接用意する（起票は別のテストで検証する）。 */
const insertTask = async (projectId: string, title: string, storyId: string | null = null) => {
  const id = crypto.randomUUID();
  const sortOrder = ((await database.selectFrom("task").select(({ fn }) => fn.max("sort_order").as("m")).where("project_id", "=", projectId).executeTakeFirst())?.m ?? 0) + 1;
  await database
    .insertInto("task")
    .values({ id, project_id: projectId, story_id: storyId, title, description: null, status: TaskStatus.TODO, assignee: null, reject_reason: null, resume_source_status: null, sort_order: sortOrder, created_at: now, updated_at: now })
    .execute();
  return { id };
};

const createProjectTask = async () => {
  const project = await createProject();
  const task = await insertTask(project.id, "Task A");
  return { project, task };
};

const grant = (projectId: string, principalId: string, role: ProjectRole) =>
  services.grantProjectRoleUseCase.execute(projectId, { principalId, role });

const revoke = (projectId: string, principalId: string, role: ProjectRole) =>
  services.revokeProjectRoleUseCase.execute(projectId, { principalId, role });

const taskStatus = async (taskId: string) =>
  (await database.selectFrom("task").select("status").where("id", "=", taskId).executeTakeFirstOrThrow()).status;

const hasCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

test("worker, reviewer, and manager complete the guarded Claim lifecycle", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "reviewer-a", ProjectRole.REVIEWER);
  await grant(project.id, "manager-a", ProjectRole.MANAGER);

  const available = await service.listTasks("worker-a", project.id, { availableFor: "work" });
  assert.deepEqual(available.tasks.map((candidate) => candidate.id), [task.id]);

  const workClaim = await service.claimTask("worker-a", task.id, "claim-work");
  await service.addTaskComment(
    "worker-a",
    task.id,
    workClaim.claimId,
    "Implemented and tested",
    "comment-work",
  );
  await service.completeTask("worker-a", task.id, workClaim.claimId, "complete-work");

  const reviewCandidates = await service.listTasks("reviewer-a", project.id, {
    availableFor: "review",
  });
  assert.deepEqual(reviewCandidates.tasks.map((candidate) => candidate.id), [task.id]);
  const reviewClaim = await service.claimReview("reviewer-a", task.id, "claim-review");
  await service.reviewedTask("reviewer-a", task.id, reviewClaim.claimId, "review-task");

  const acceptanceCandidates = await service.listTasks("manager-a", project.id, {
    availableFor: "acceptance",
  });
  assert.deepEqual(acceptanceCandidates.tasks.map((candidate) => candidate.id), [task.id]);
  const acceptanceClaim = await service.claimAcceptance(
    "manager-a",
    task.id,
    "claim-acceptance",
  );
  const accepted = await service.acceptTask(
    "manager-a",
    task.id,
    acceptanceClaim.claimId,
    "accept-task",
  );
  assert.equal(accepted.status, TaskStatus.ACCEPTED);

  assert.equal(await taskStatus(task.id), TaskStatus.ACCEPTED);
  const comments = await service.listTaskComments("manager-a", task.id);
  assert.equal(comments.comments[0]?.principalId, "worker-a");
  assert.equal(comments.comments[0]?.claimId, workClaim.claimId);

  const changes = await service.listChanges("manager-a", project.id);
  assert.deepEqual(
    changes.changes.map((change) => change.type),
    ["TASK_CLAIMED", "TASK_COMPLETED", "TASK_CLAIMED", "TASK_REVIEWED", "TASK_CLAIMED", "TASK_ACCEPTED"],
  );
  assert.deepEqual(
    changes.changes.map((change) => change.payload.actorRole),
    ["worker", "worker", "reviewer", "reviewer", "manager", "manager"],
  );
});

test("expired doing Claim is available for work and is atomically replaced", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "worker-b", ProjectRole.WORKER);

  const first = await service.claimTask("worker-a", task.id, "first-claim");
  now = first.expiresAt + 1;

  const available = await service.listTasks("worker-b", project.id, { availableFor: "work" });
  assert.equal(available.tasks[0]?.status, TaskStatus.DOING);
  assert.equal(available.tasks[0]?.reclaimable, true);

  const second = await service.claimTask("worker-b", task.id, "second-claim");
  assert.notEqual(second.claimId, first.claimId);
  const oldClaim = await database.selectFrom("task_claim")
    .selectAll()
    .where("id", "=", first.claimId)
    .executeTakeFirstOrThrow();
  assert.equal(oldClaim.state, "expired");
  await assert.rejects(
    () => service.renewClaim("worker-a", first.claimId),
    hasCode("CLAIM_EXPIRED"),
  );
});

test("renew_claim extends only the owned Task Claim lease", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "worker-b", ProjectRole.WORKER);
  const claim = await service.claimTask("worker-a", task.id, "claim");

  now = 1_500;
  const renewed = await service.renewClaim("worker-a", claim.claimId);
  assert.equal(renewed.expiresAt, 2_500);
  await assert.rejects(
    () => service.renewClaim("worker-b", claim.claimId),
    hasCode("CLAIM_NOT_OWNED"),
  );

  now = claim.expiresAt + 1;
  await service.addTaskComment("worker-a", task.id, claim.claimId, "still working", "comment");
});

test("claim conflict is structured and idempotent retry returns the original Claim", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "worker-b", ProjectRole.WORKER);

  const first = await service.claimTask("worker-a", task.id, "same-request");
  const retry = await service.claimTask("worker-a", task.id, "same-request");
  assert.equal(retry.claimId, first.claimId);
  await assert.rejects(
    () => service.claimTask("worker-b", task.id, "other-request"),
    hasCode("CLAIM_CONFLICT"),
  );
});

test("concurrent work Claims produce one winner and one structured conflict", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "worker-b", ProjectRole.WORKER);

  const results = await Promise.allSettled([
    service.claimTask("worker-a", task.id, "race-a"),
    service.claimTask("worker-b", task.id, "race-b"),
  ]);
  const fulfilled = results.filter((result) => result.status === "fulfilled");
  const rejected = results.filter((result) => result.status === "rejected");

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(hasCode("CLAIM_CONFLICT")((rejected[0] as PromiseRejectedResult).reason));
  assert.equal(
    await database.selectFrom("task_claim")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("task_id", "=", task.id)
      .where("state", "=", "active")
      .executeTakeFirstOrThrow()
      .then((row) => Number(row.count)),
    1,
  );
});

test("requestId cannot be reused with different input", async () => {
  const { project, task } = await createProjectTask();
  const another = await insertTask(project.id, "Task B");
  await grant(project.id, "worker-a", ProjectRole.WORKER);

  await service.claimTask("worker-a", task.id, "reused-request");
  await assert.rejects(
    () => service.claimTask("worker-a", another.id, "reused-request"),
    hasCode("IDEMPOTENCY_CONFLICT"),
  );
});

test("idempotency compares object input independent of key order", async () => {
  const project = await createProject();
  await grant(project.id, "manager-a", ProjectRole.MANAGER);

  const first = await service.issueStory(
    "manager-a",
    { projectId: project.id, title: "Story", description: "Description" },
    "same-story-request",
  );
  const retry = await service.issueStory(
    "manager-a",
    { description: "Description", title: "Story", projectId: project.id },
    "same-story-request",
  );

  assert.equal(retry.id, first.id);
});

test("released work Claim returns the Task to todo and fences the old Claim", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);

  const claim = await service.claimTask("worker-a", task.id, "claim");
  const released = await service.releaseClaim(
    "worker-a",
    claim.claimId,
    "pairing session ended",
    "release",
  );

  assert.equal(released.taskStatus, TaskStatus.TODO);
  assert.equal(await taskStatus(task.id), TaskStatus.TODO);
  await assert.rejects(
    () => service.addTaskComment("worker-a", task.id, claim.claimId, "late", "late-comment"),
    hasCode("CLAIM_EXPIRED"),
  );
});

test("Manager cancellation releases and fences an active work Claim", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "manager-a", ProjectRole.MANAGER);
  const claim = await service.claimTask("worker-a", task.id, "claim");

  await service.cancelTask("manager-a", task.id, "no longer needed", "cancel");

  assert.equal(await taskStatus(task.id), TaskStatus.CANCELED);
  await assert.rejects(
    () => service.addTaskComment("worker-a", task.id, claim.claimId, "late", "late-comment"),
    hasCode("CLAIM_EXPIRED"),
  );
});

test("self-review and self-acceptance compare Principal IDs", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "multi-role", ProjectRole.WORKER);
  await grant(project.id, "multi-role", ProjectRole.REVIEWER);
  await grant(project.id, "multi-role", ProjectRole.MANAGER);

  const claim = await service.claimTask("multi-role", task.id, "work");
  await service.addTaskComment("multi-role", task.id, claim.claimId, "verified", "comment");
  await service.completeTask("multi-role", task.id, claim.claimId, "complete");

  const reviewCandidates = await service.listTasks("multi-role", project.id, {
    availableFor: "review",
  });
  assert.deepEqual(reviewCandidates.tasks, []);
  const acceptanceCandidates = await service.listTasks("multi-role", project.id, {
    availableFor: "acceptance",
  });
  assert.deepEqual(acceptanceCandidates.tasks, []);

  await assert.rejects(
    () => service.claimReview("multi-role", task.id, "review"),
    hasCode("SELF_REVIEW_NOT_ALLOWED"),
  );
  await assert.rejects(
    () => service.claimAcceptance("multi-role", task.id, "acceptance"),
    hasCode("SELF_ACCEPTANCE_NOT_ALLOWED"),
  );
});

test("Manager direct review moves in_review to wait_accept when acceptance is claimed", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "manager-a", ProjectRole.MANAGER);

  const work = await service.claimTask("worker-a", task.id, "work");
  await service.addTaskComment("worker-a", task.id, work.claimId, "verified", "comment");
  await service.completeTask("worker-a", task.id, work.claimId, "complete");

  const acceptance = await service.claimAcceptance("manager-a", task.id, "direct-review");
  assert.equal(acceptance.taskStatus, TaskStatus.WAIT_ACCEPT);
  assert.equal(await taskStatus(task.id), TaskStatus.WAIT_ACCEPT);

  const changes = await service.listChanges("manager-a", project.id);
  const claimed = changes.changes.at(-1);
  assert.equal(claimed?.payload.path, "manager_direct_review");
});

test("Task Comment requires the current owned Claim", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "worker-b", ProjectRole.WORKER);
  const claim = await service.claimTask("worker-a", task.id, "work");

  await assert.rejects(
    () => service.addTaskComment("worker-b", task.id, claim.claimId, "spoof", "comment"),
    hasCode("CLAIM_NOT_OWNED"),
  );
});

test("Task Comment requires the Role for the current Claim phase", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  const claim = await service.claimTask("worker-a", task.id, "work");
  await revoke(project.id, "worker-a", ProjectRole.WORKER);

  await assert.rejects(
    () => service.addTaskComment("worker-a", task.id, claim.claimId, "late", "comment"),
    hasCode("FORBIDDEN"),
  );
});

test("status and availableFor filters are mutually exclusive", async () => {
  const { project } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await assert.rejects(
    () =>
      service.listTasks("worker-a", project.id, {
        status: [TaskStatus.TODO],
        availableFor: "work",
      }),
    hasCode("INVALID_FILTER_COMBINATION"),
  );
});

test("availableFor returns only candidates claimable by the Principal Role", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "manager-a", ProjectRole.MANAGER);

  const available = await service.listTasks("manager-a", project.id, {
    availableFor: "work",
  });

  assert.deepEqual(available.tasks, []);
  await assert.rejects(
    () => service.claimTask("manager-a", task.id, "claim-without-worker-role"),
    hasCode("FORBIDDEN"),
  );
});

test("worker and reviewer can create technical follow-up Tasks", async () => {
  const project = await createProject("Follow-up");
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "reviewer-a", ProjectRole.REVIEWER);

  const workerTask = await service.issueTask(
    "worker-a",
    { projectId: project.id, title: "Worker follow-up" },
    "worker-follow-up",
  );
  const reviewerTask = await service.issueTask(
    "reviewer-a",
    { projectId: project.id, title: "Reviewer follow-up" },
    "reviewer-follow-up",
  );

  assert.equal(workerTask.status, TaskStatus.TODO);
  assert.equal(reviewerTask.status, TaskStatus.TODO);
  const changes = await service.listChanges("reviewer-a", project.id);
  assert.deepEqual(
    changes.changes.map((change) => change.payload.actorRole),
    ["worker", "reviewer"],
  );
});

test("accepting the final Story Task appends STORY_COMPLETED", async () => {
  const project = await createProject("Story completion");
  await grant(project.id, "manager-a", ProjectRole.MANAGER);
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await grant(project.id, "reviewer-a", ProjectRole.REVIEWER);
  const story = await service.issueStory(
    "manager-a",
    { projectId: project.id, title: "Story" },
    "story",
  );
  const task = await service.issueTask(
    "manager-a",
    { projectId: project.id, storyId: story.id, title: "Task" },
    "task",
  );
  const work = await service.claimTask("worker-a", task.id, "work");
  await service.addTaskComment("worker-a", task.id, work.claimId, "verified", "comment");
  await service.completeTask("worker-a", task.id, work.claimId, "complete");
  const review = await service.claimReview("reviewer-a", task.id, "review");
  await service.reviewedTask("reviewer-a", task.id, review.claimId, "reviewed");
  const acceptance = await service.claimAcceptance("manager-a", task.id, "acceptance");
  await service.acceptTask("manager-a", task.id, acceptance.claimId, "accepted");

  const savedStory = await database.selectFrom("story")
    .select("status")
    .where("id", "=", story.id)
    .executeTakeFirstOrThrow();
  assert.equal(savedStory.status, "done");
  const changes = await service.listChanges("manager-a", project.id);
  assert.equal(changes.changes.at(-1)?.type, "STORY_COMPLETED");
  assert.equal(changes.changes.at(-1)?.payload.path, "task_acceptance");
});

test("Task ordering uses parent Story sortOrder before Task sortOrder", async () => {
  const project = await createProject("Ordering");
  await grant(project.id, "manager-a", ProjectRole.MANAGER);
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  const laterStory = await service.issueStory(
    "manager-a",
    { projectId: project.id, title: "Later" },
    "story-later",
  );
  const earlierStory = await service.issueStory(
    "manager-a",
    { projectId: project.id, title: "Earlier" },
    "story-earlier",
  );
  await service.editStory(
    "manager-a",
    { projectId: project.id, storyId: laterStory.id, title: laterStory.title, sortOrder: 20 },
    "order-later",
  );
  await service.editStory(
    "manager-a",
    { projectId: project.id, storyId: earlierStory.id, title: earlierStory.title, sortOrder: 10 },
    "order-earlier",
  );
  const laterTask = await service.issueTask(
    "manager-a",
    { projectId: project.id, storyId: laterStory.id, title: "Later Task" },
    "task-later",
  );
  const earlierTask = await service.issueTask(
    "manager-a",
    { projectId: project.id, storyId: earlierStory.id, title: "Earlier Task" },
    "task-earlier",
  );

  const result = await service.listTasks("worker-a", project.id, { availableFor: "work" });

  assert.deepEqual(
    result.tasks.map((task) => task.id),
    [earlierTask.id, laterTask.id],
  );
});

test("Manager cannot attach a Task to a Story from another Project", async () => {
  const first = await createProject("First");
  const second = await createProject("Second");
  await grant(first.id, "manager-a", ProjectRole.MANAGER);
  await grant(second.id, "manager-a", ProjectRole.MANAGER);
  const foreignStory = await service.issueStory(
    "manager-a",
    { projectId: second.id, title: "Foreign Story" },
    "foreign-story",
  );

  await assert.rejects(
    () =>
      service.issueTask(
        "manager-a",
        { projectId: first.id, storyId: foreignStory.id, title: "Invalid Task" },
        "invalid-task",
      ),
    hasCode("INVALID_INPUT"),
  );
});
