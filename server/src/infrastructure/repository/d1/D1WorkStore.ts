import type { D1Database } from "@cloudflare/workers-types";
import type { CompiledQuery, Kysely } from "kysely";
import { KyselyWorkStore, type WorkDatabase, type WorkExternalReaders, type WorkStore, type WorkChangeNotice,
  type StoryRecord, type TaskRecord, type TaskClaimRecord, type TaskCommentRecord, type TaskPullRequestRecord,
  type PublicationRecord, type PublicationRevisionRecord, type CommandReceiptRecord, type TaskConsultationWait } from "@compass/work";
import { ConflictError, NotFoundError } from "@compass/shared";
import { D1WritePlan, type D1PlanTables } from "../../database/d1/D1WritePlan.ts";
import { D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { createD1Database } from "../../database/d1/D1Dialect.ts";
import { asWorkDatabase } from "../../database/contextDatabase.ts";

const tables: D1PlanTables = {
  story: { key: ["id"] }, task: { key: ["id"] }, task_claim: { key: ["id"] }, task_comment: { key: ["id"] },
  task_pull_request: { key: ["id"] }, task_consultation_wait: { key: ["task_id"] },
  change_log: { key: ["cursor"], rowIdColumn: "cursor" }, command_receipt: { key: ["principal_id", "tool_name", "request_id"] },
  publication_record: { key: ["id"] }, publication_revision: { key: ["publication_id", "commit_sha"] },
};
export type D1WorkChangePlanner = (database: D1WritePlan["database"], notice: WorkChangeNotice) => Promise<CompiledQuery[]>;

/** ApplicationのUnit of WorkをSQL保存計画へ変換し、業務規則は既存Serviceへ残す。 */
export class D1WorkStore extends KyselyWorkStore {
  constructor(private readonly database: Kysely<WorkDatabase>, private readonly binding: D1Database,
    private readonly readers: WorkExternalReaders, private readonly changePlanner: D1WorkChangePlanner | null = null,
    private readonly plan?: D1WritePlan) {
    // 計画外の参照もread-onlyにし、継承した更新メソッドの追加漏れで原子性を迂回させない。
    super(plan ? asWorkDatabase(plan.database) : asWorkDatabase(createD1Database(binding, { readOnly: true })), readers);
  }

  override async transaction<T>(work: (store: WorkStore) => Promise<T>): Promise<T> {
    if (this.plan) return work(this);
    for (let attempt = 0; attempt < 3; attempt++) {
      const plan = new D1WritePlan(this.binding, tables);
      try {
        const store = new D1WorkStore(this.database, this.binding, this.readers, this.changePlanner, plan);
        const result = await work(store);
        await plan.commit();
        return result;
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
      finally { await plan.dispose(); }
    }
    throw new ConflictError("Work changed repeatedly while the command was being committed; retry with the same request ID");
  }

  private write<T>(work: (plan: D1WritePlan, store: D1WorkStore) => Promise<T>): Promise<T> {
    return this.plan ? work(this.plan, this) : this.transaction((store) => work((store as D1WorkStore).plan!, store as D1WorkStore));
  }
  override insertStory(row: StoryRecord) { return this.write((plan) => plan.insert("story", row)); }
  override updateStory(id: string, patch: Parameters<WorkStore["updateStory"]>[1]): Promise<StoryRecord> {
    return this.write(async (plan) => { const row = await plan.update("story", { id }, patch); if (!row) throw new NotFoundError(`Story ${id} was not found`); return row as StoryRecord; });
  }
  override updateStoryStatusIf(id: string, from: StoryRecord["status"], to: StoryRecord["status"], at: number) {
    return this.write(async (plan) => await plan.update("story", { id }, { status: to, updated_at: at }, { status: from }) !== null);
  }
  override insertTask(row: TaskRecord) { return this.write((plan) => plan.insert("task", row)); }
  override updateTask(id: string, patch: Parameters<WorkStore["updateTask"]>[1]): Promise<TaskRecord> {
    return this.write(async (plan) => { const row = await plan.update("task", { id }, patch); if (!row) throw new NotFoundError(`Task ${id} was not found`); return row as TaskRecord; });
  }
  override insertClaim(row: TaskClaimRecord) {
    return this.write(async (plan, store) => {
      if (await store.findClaim(row.id) || await store.findActiveClaim(row.task_id)) return false;
      await plan.insert("task_claim", row); return true;
    });
  }
  override updateClaim(id: string, patch: Parameters<WorkStore["updateClaim"]>[1], options: { onlyActive?: boolean } = {}) {
    return this.write(async (plan) => { await plan.update("task_claim", { id }, patch, options.onlyActive ? { state: "active" } : {}); });
  }
  override insertTaskComment(row: TaskCommentRecord) { return this.write(async (plan) => { await plan.insert("task_comment", row); }); }
  override saveConsultationWait(row: TaskConsultationWait) { return this.write((plan) => plan.upsert("task_consultation_wait", row)); }
  override deleteConsultationWait(taskId: string) { return this.write((plan) => plan.delete("task_consultation_wait", { task_id: taskId })); }
  override insertTaskPullRequest(row: TaskPullRequestRecord) { return this.write(async (plan) => { await plan.insert("task_pull_request", row); }); }
  override updateTaskPullRequest(id: string, patch: Parameters<WorkStore["updateTaskPullRequest"]>[1]) {
    return this.write(async (plan) => { await plan.update("task_pull_request", { id }, patch); });
  }
  override insertPublication(row: PublicationRecord, revisions: PublicationRevisionRecord[]) {
    return this.write(async (plan) => { await plan.insert("publication_record", row); for (const revision of revisions) await plan.insert("publication_revision", revision); });
  }
  override insertReceipt(row: CommandReceiptRecord) { return this.write(async (plan) => { await plan.insert("command_receipt", row); }); }

  override appendChange(change: Parameters<WorkStore["appendChange"]>[0]) {
    return this.write(async (plan, store) => {
      const cursor = await plan.nextRowId("change_log");
      await plan.insert("change_log", { ...change, cursor });
      if (this.changePlanner) {
        const task = await store.findTask(change.entity_id);
        const story = task ? null : await store.findStory(change.entity_id);
        const subject: WorkChangeNotice["subject"] = task ? { kind: "task", id: task.id, title: task.title, storyId: task.story_id }
          : story ? { kind: "story", id: story.id, title: story.title, storyId: null } : null;
        plan.add(...await this.changePlanner(plan.database, { ...change, cursor, subject }));
      }
      return cursor;
    });
  }
}
