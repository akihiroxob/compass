import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import {
  CoordinationError,
  KyselyWorkStore,
  type DirectionReferenceLookupPort,
  TaskCoordinationService,
  TaskStatus,
} from "@compass/work";
import { ProjectArchivedError } from "@compass/direction";
import { ProjectRole } from "../src/constants/ProjectRole.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { asWorkDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { workExternalReaders } from "../src/infrastructure/repository/workExternalReaders.ts";

/**
 * Work（`TaskCoordinationService`）と、serverが配線する実際のRole Grant（Access）・Project（Direction）との結合テスト。
 * Grantの付与・取消とProjectのarchiveが、Claim・状態遷移と同じtransactionの検査へ反映されることを確認する。
 * 排他Claim・期限・状態遷移・冪等性などWork単体の規則は`packages/work/tests/taskCoordination.test.ts`で検証する。
 * Directionを参照しない操作では読取ポートは使われないため、呼ばれたら失敗するstubにしている。
 */
const noDirectionReferences: DirectionReferenceLookupPort = {
  getOutcomeSnapshot: async () => assert.fail("Directionを参照しない操作でOutcomeを読んではならない"),
  getRepositoryReference: async () => assert.fail("Directionを参照しない操作でRepositoryを読んではならない"),
};

let database = createDatabase(":memory:");
let services = createApplicationServices(database);
let now = 1_000;
const workStore = () => new KyselyWorkStore(asWorkDatabase(database), workExternalReaders);
let service = new TaskCoordinationService(workStore(), noDirectionReferences, () => now, 1_000);

beforeEach(async () => {
  await database.destroy();
  database = createDatabase(":memory:");
  await initializeSchema(database);
  services = createApplicationServices(database);
  now = 1_000;
  service = new TaskCoordinationService(workStore(), noDirectionReferences, () => now, 1_000);
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

test("archived Project rejects new work Claims through the wired Project state", async () => {
  const { project, task } = await createProjectTask();
  await grant(project.id, "worker-a", ProjectRole.WORKER);
  await services.archiveProjectUseCase.execute(project.id, { reason: "closed" });

  await assert.rejects(() => service.claimTask("worker-a", task.id, "claim"), ProjectArchivedError);
  assert.equal(await taskStatus(task.id), TaskStatus.TODO);
});
