import type { Kysely, Transaction } from "kysely";
import type { StoryStatus } from "../domain/StoryStatus.ts";
import { TaskStatus } from "../domain/TaskStatus.ts";
import type {
  ChangeRecord,
  CommandReceiptRecord,
  EntityCorrelation,
  OutcomeTargetReader,
  ProjectGrantReader,
  ProjectStateReader,
  StoryRecord,
  TaskClaimRecord,
  TaskCommentRecord,
  TaskRecord,
  WorkChangeNotice,
  WorkStore,
} from "../application/port/WorkStore.ts";
import type { WorkDatabase } from "./schema.ts";

type Executor = Kysely<WorkDatabase> | Transaction<WorkDatabase>;

/**
 * Workの外（Access・Direction）が所有するtableの読取。serverが同じ接続・transactionで読む実装を渡す。
 * Work自身はproject・project_grant・outcome_target_projectのtableを扱わない。
 */
export type WorkExternalReaders = (executor: Executor) => {
  grants: ProjectGrantReader;
  projects: ProjectStateReader;
  outcomeTargets: OutcomeTargetReader;
};

/**
 * 追記したChangeを、同じ接続・transactionでWorkの外へ通知する（例: canonical Activityの生成）。serverが配線する。
 * 通知先の失敗は呼び出し元の状態変更ごと巻き戻る。
 */
export type WorkChangeObserver = (executor: Executor) => (notice: WorkChangeNotice) => Promise<void>;

const toChange = (row: { cursor: number | bigint } & Omit<ChangeRecord, "cursor">): ChangeRecord => ({
  ...row,
  cursor: Number(row.cursor),
});

/** `WorkStore`のKysely（SQLite）実装。`transaction`の中では、外部readerも同じtransactionで読む。 */
export class KyselyWorkStore implements WorkStore {
  readonly grants: ProjectGrantReader;
  readonly projects: ProjectStateReader;
  readonly outcomeTargets: OutcomeTargetReader;

  constructor(
    private readonly db: Executor,
    private readonly externalReaders: WorkExternalReaders,
    private readonly changeObserver: WorkChangeObserver | null = null,
  ) {
    const readers = externalReaders(db);
    this.grants = readers.grants;
    this.projects = readers.projects;
    this.outcomeTargets = readers.outcomeTargets;
  }

  transaction<T>(work: (store: WorkStore) => Promise<T>): Promise<T> {
    return this.db.transaction().execute((transaction) =>
      work(new KyselyWorkStore(transaction, this.externalReaders, this.changeObserver)),
    );
  }

  async findStory(storyId: string): Promise<StoryRecord | null> {
    return (await this.db.selectFrom("story").selectAll().where("id", "=", storyId).executeTakeFirst()) ?? null;
  }

  async findStoryInProject(projectId: string, storyId: string): Promise<StoryRecord | null> {
    return (
      (await this.db
        .selectFrom("story")
        .selectAll()
        .where("id", "=", storyId)
        .where("project_id", "=", projectId)
        .executeTakeFirst()) ?? null
    );
  }

  async findStoryByCorrelation(projectId: string, correlationId: string): Promise<StoryRecord | null> {
    return (
      (await this.db
        .selectFrom("story")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("correlation_id", "=", correlationId)
        .executeTakeFirst()) ?? null
    );
  }

  listStories(projectId: string, status?: string): Promise<StoryRecord[]> {
    let query = this.db.selectFrom("story").selectAll().where("project_id", "=", projectId);
    if (status) query = query.where("status", "=", status as StoryStatus);
    return query.orderBy("sort_order", "asc").orderBy("created_at", "asc").execute();
  }

  listStoriesByOutcome(projectId: string, outcomeId: string): Promise<StoryRecord[]> {
    return this.db
      .selectFrom("story")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("outcome_ref", "=", outcomeId)
      .orderBy("sort_order", "asc")
      .orderBy("created_at", "asc")
      .execute();
  }

  listStoriesByOutcomeProjects(refs: { projectId: string; outcomeId: string }[]): Promise<StoryRecord[]> {
    if (refs.length === 0) return Promise.resolve([]);
    return this.db
      .selectFrom("story")
      .selectAll()
      .where((eb) =>
        eb.or(refs.map(({ projectId, outcomeId }) => eb.and([eb("project_id", "=", projectId), eb("outcome_ref", "=", outcomeId)]))),
      )
      .orderBy("sort_order", "asc")
      .orderBy("created_at", "asc")
      .execute();
  }

  async maxStorySortOrder(projectId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom("story")
      .select(({ fn }) => fn.max("sort_order").as("max_sort_order"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row?.max_sort_order ?? null;
  }

  insertStory(story: StoryRecord): Promise<StoryRecord> {
    return this.db.insertInto("story").values(story).returningAll().executeTakeFirstOrThrow();
  }

  updateStory(storyId: string, patch: Parameters<WorkStore["updateStory"]>[1]): Promise<StoryRecord> {
    return this.db.updateTable("story").set(patch).where("id", "=", storyId).returningAll().executeTakeFirstOrThrow();
  }

  async updateStoryStatusIf(storyId: string, from: StoryStatus, to: StoryStatus, updatedAt: number): Promise<boolean> {
    const result = await this.db
      .updateTable("story")
      .set({ status: to, updated_at: updatedAt })
      .where("id", "=", storyId)
      .where("status", "=", from)
      .executeTakeFirst();
    return result.numUpdatedRows > 0n;
  }

  async findTask(taskId: string): Promise<TaskRecord | null> {
    return (await this.db.selectFrom("task").selectAll().where("id", "=", taskId).executeTakeFirst()) ?? null;
  }

  async findTaskInProject(projectId: string, taskId: string): Promise<TaskRecord | null> {
    return (
      (await this.db
        .selectFrom("task")
        .selectAll()
        .where("id", "=", taskId)
        .where("project_id", "=", projectId)
        .executeTakeFirst()) ?? null
    );
  }

  async findTaskByKey(storyId: string | null, taskKey: string): Promise<TaskRecord | null> {
    return (
      (await this.db
        .selectFrom("task")
        .selectAll()
        .where("story_id", "=", storyId)
        .where("task_key", "=", taskKey)
        .executeTakeFirst()) ?? null
    );
  }

  listTasks(projectId: string): Promise<TaskRecord[]> {
    return this.db.selectFrom("task").selectAll().where("project_id", "=", projectId).execute();
  }

  listTasksOfStories(projectId: string, storyIds: string[]): Promise<TaskRecord[]> {
    if (storyIds.length === 0) return Promise.resolve([]);
    return this.db
      .selectFrom("task")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("story_id", "in", storyIds)
      .execute();
  }

  async countTasksOfStories(storyIds: string[]): Promise<{ story_id: string; status: string; count: number }[]> {
    if (storyIds.length === 0) return [];
    const rows = await this.db
      .selectFrom("task")
      .innerJoin("story", (join) => join.onRef("story.id", "=", "task.story_id").onRef("story.project_id", "=", "task.project_id"))
      .select(({ fn }) => ["story.id as story_id", "task.status as status", fn.countAll<number>().as("count")])
      .where("story.id", "in", storyIds)
      .groupBy(["story.id", "task.status"])
      .execute();
    return rows.map((row) => ({ story_id: row.story_id, status: row.status, count: Number(row.count) }));
  }

  async hasUnsettledTask(storyId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("task")
      .select("id")
      .where("story_id", "=", storyId)
      .where("status", "not in", [TaskStatus.ACCEPTED, TaskStatus.CANCELED])
      .executeTakeFirst();
    return row !== undefined;
  }

  async maxTaskSortOrder(projectId: string): Promise<number | null> {
    const row = await this.db
      .selectFrom("task")
      .select(({ fn }) => fn.max("sort_order").as("max_sort_order"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row?.max_sort_order ?? null;
  }

  insertTask(task: TaskRecord): Promise<TaskRecord> {
    return this.db.insertInto("task").values(task).returningAll().executeTakeFirstOrThrow();
  }

  updateTask(taskId: string, patch: Parameters<WorkStore["updateTask"]>[1]): Promise<TaskRecord> {
    return this.db.updateTable("task").set(patch).where("id", "=", taskId).returningAll().executeTakeFirstOrThrow();
  }

  async findClaim(claimId: string): Promise<TaskClaimRecord | null> {
    return (await this.db.selectFrom("task_claim").selectAll().where("id", "=", claimId).executeTakeFirst()) ?? null;
  }

  async findActiveClaim(taskId: string): Promise<TaskClaimRecord | null> {
    return (
      (await this.db
        .selectFrom("task_claim")
        .selectAll()
        .where("task_id", "=", taskId)
        .where("state", "=", "active")
        .executeTakeFirst()) ?? null
    );
  }

  listActiveClaims(projectId: string): Promise<TaskClaimRecord[]> {
    return this.db
      .selectFrom("task_claim")
      .selectAll()
      .where("state", "=", "active")
      .where("task_id", "in", this.db.selectFrom("task").select("id").where("project_id", "=", projectId))
      .execute();
  }

  async insertClaim(claim: TaskClaimRecord): Promise<boolean> {
    try {
      await this.db.insertInto("task_claim").values(claim).execute();
      return true;
    } catch (error) {
      // 有効なClaimはTaskごとに1件（`task_claim_active_task_idx`）。同時取得の敗者はここで検出する。
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) return false;
      throw error;
    }
  }

  async updateClaim(
    claimId: string,
    patch: Parameters<WorkStore["updateClaim"]>[1],
    options: { onlyActive?: boolean } = {},
  ): Promise<void> {
    let query = this.db.updateTable("task_claim").set(patch).where("id", "=", claimId);
    if (options.onlyActive) query = query.where("state", "=", "active");
    await query.execute();
  }

  listTaskComments(taskId: string): Promise<TaskCommentRecord[]> {
    return this.db.selectFrom("task_comment").selectAll().where("task_id", "=", taskId).orderBy("created_at", "asc").execute();
  }

  async insertTaskComment(comment: TaskCommentRecord): Promise<void> {
    await this.db.insertInto("task_comment").values(comment).execute();
  }

  async hasClaimComment(taskId: string, claimId: string, principalId: string): Promise<boolean> {
    const row = await this.db
      .selectFrom("task_comment")
      .select("id")
      .where("task_id", "=", taskId)
      .where("claim_id", "=", claimId)
      .where("principal_id", "=", principalId)
      .executeTakeFirst();
    return row !== undefined;
  }

  async appendChange(change: Omit<ChangeRecord, "cursor">): Promise<number> {
    const row = await this.db.insertInto("change_log").values(change).returning("cursor").executeTakeFirstOrThrow();
    const cursor = Number(row.cursor);
    if (this.changeObserver) {
      await this.changeObserver(this.db)({ ...change, cursor, subject: await this.findChangeSubject(change.entity_id) });
    }
    return cursor;
  }

  /** Changeの対象（Story / Task）。Claim等のIDなど、どちらでもなければnull。 */
  private async findChangeSubject(entityId: string): Promise<WorkChangeNotice["subject"]> {
    const task = await this.db
      .selectFrom("task")
      .select(["id", "title", "story_id"])
      .where("id", "=", entityId)
      .executeTakeFirst();
    if (task) return { kind: "task", id: task.id, title: task.title, storyId: task.story_id };
    const story = await this.db.selectFrom("story").select(["id", "title"]).where("id", "=", entityId).executeTakeFirst();
    return story ? { kind: "story", id: story.id, title: story.title, storyId: null } : null;
  }

  async findLatestCompleter(taskId: string): Promise<string | null> {
    const row = await this.db
      .selectFrom("change_log")
      .select("principal_id")
      .where("entity_id", "=", taskId)
      .where("type", "=", "TASK_COMPLETED")
      .orderBy("cursor", "desc")
      .executeTakeFirst();
    return row?.principal_id ?? null;
  }

  listCompletions(projectId: string): Promise<Pick<ChangeRecord, "entity_id" | "principal_id">[]> {
    return this.db
      .selectFrom("change_log")
      .select(["entity_id", "principal_id"])
      .where("project_id", "=", projectId)
      .where("type", "=", "TASK_COMPLETED")
      .orderBy("cursor", "desc")
      .execute();
  }

  async listEntityChanges(projectId: string, entityId: string): Promise<ChangeRecord[]> {
    const rows = await this.db
      .selectFrom("change_log")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("entity_id", "=", entityId)
      .orderBy("cursor", "asc")
      .execute();
    return rows.map(toChange);
  }

  async listChangesAfter(projectId: string, afterCursor: number, limit: number): Promise<ChangeRecord[]> {
    const rows = await this.db
      .selectFrom("change_log")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("cursor", ">", afterCursor)
      .orderBy("cursor", "asc")
      .limit(limit)
      .execute();
    return rows.map(toChange);
  }

  async listChangesBefore(projectId: string, beforeCursor: number | null, limit: number): Promise<ChangeRecord[]> {
    let query = this.db.selectFrom("change_log").selectAll().where("project_id", "=", projectId);
    if (beforeCursor !== null) query = query.where("cursor", "<", beforeCursor);
    const rows = await query.orderBy("cursor", "desc").limit(limit).execute();
    return rows.map(toChange);
  }

  async maxChangeCursor(projectId: string, entityIds?: string[]): Promise<number> {
    let query = this.db
      .selectFrom("change_log")
      .select(({ fn }) => fn.max("cursor").as("cursor"))
      .where("project_id", "=", projectId);
    if (entityIds !== undefined) {
      if (entityIds.length === 0) return 0;
      query = query.where("entity_id", "in", entityIds);
    }
    const row = await query.executeTakeFirst();
    return Number(row?.cursor ?? 0);
  }

  async listEntityCorrelations(projectId: string, entityIds: string[]): Promise<EntityCorrelation[]> {
    if (entityIds.length === 0) return [];
    const stories = await this.db
      .selectFrom("story")
      .select(["id", "outcome_ref", "correlation_id"])
      .where("project_id", "=", projectId)
      .where("id", "in", entityIds)
      .execute();
    const tasks = await this.db
      .selectFrom("task")
      .innerJoin("story", "story.id", "task.story_id")
      .select(["task.id as id", "story.outcome_ref as outcome_ref", "story.correlation_id as correlation_id"])
      .where("task.project_id", "=", projectId)
      .where("task.id", "in", entityIds)
      .execute();
    return [...stories, ...tasks];
  }

  async findReceipt(principalId: string, toolName: string, requestId: string): Promise<CommandReceiptRecord | null> {
    return (
      (await this.db
        .selectFrom("command_receipt")
        .selectAll()
        .where("principal_id", "=", principalId)
        .where("tool_name", "=", toolName)
        .where("request_id", "=", requestId)
        .executeTakeFirst()) ?? null
    );
  }

  async insertReceipt(receipt: CommandReceiptRecord): Promise<void> {
    await this.db.insertInto("command_receipt").values(receipt).execute();
  }
}
