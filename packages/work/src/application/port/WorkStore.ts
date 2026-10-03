import type { StoryStatus } from "../../domain/StoryStatus.ts";
import type { TaskStatus } from "../../domain/TaskStatus.ts";

/**
 * Workが保存するrecord。項目名は保存形式（列名）と同じにし、Kysely等のDB clientの型には依存しない。
 * Story / Taskの状態遷移・Claimの排他と期限・自己レビュー禁止等の規則はapplication層が持ち、storeは読み書きだけを行う。
 */

/**
 * Story。Direction側のOutcomeは参照（`outcome_ref`）と作成時のsnapshotだけを持ち、
 * outcome / success_criterion / projectのtableを読み書きしない。snapshotはJSON文字列。
 */
export type StoryRecord = {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: StoryStatus;
  sort_order: number;
  created_at: number;
  updated_at: number;
  /** Direction `outcome.id`への参照。FKは付けない（境界をまたぐ参照のため）。 */
  outcome_ref: string | null;
  origin_decision_id: string | null;
  /** 作成時点の固定Success Criteria（JSON配列）。 */
  success_criteria_snapshot: string | null;
  /** 作成時点のProject Constraints（JSON配列）。 */
  constraints_snapshot: string | null;
  /** 対象Repository（`{id, name, url}`のJSON）。実際のcheckoutはRuntime / Agentの責務。 */
  repository_snapshot: string | null;
  /** DirectionからのhandoffをProject内で一意にする相関ID（例: `outcome:{outcomeId}`）。 */
  correlation_id: string | null;
};

export type TaskRecord = {
  id: string;
  project_id: string;
  story_id: string | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  assignee: string | null;
  reject_reason: string | null;
  resume_source_status: string | null;
  sort_order: number;
  created_at: number;
  updated_at: number;
  /** Story内で一意なTaskの論理ID（Outcome handoffの再送収束用）。手動起票ではNULL。 */
  task_key: string | null;
};

export type TaskCommentRecord = {
  id: string;
  task_id: string;
  body: string;
  author: string | null;
  principal_id: string | null;
  claim_id: string | null;
  created_at: number;
};

export type TaskClaimRecord = {
  id: string;
  task_id: string;
  principal_id: string;
  state: string;
  acquired_at: number;
  renewed_at: number | null;
  expires_at: number;
  released_at: number | null;
  release_reason: string | null;
};

/** 追記専用のChange Log。`cursor`が取得位置になる。 */
export type ChangeRecord = {
  cursor: number;
  project_id: string;
  type: string;
  entity_id: string;
  principal_id: string;
  claim_id: string | null;
  payload: string;
  occurred_at: number;
};

/** Work toolの`requestId`冪等性。同じ`(principal_id, tool_name, request_id)`は保存した結果を再生する。 */
export type CommandReceiptRecord = {
  principal_id: string;
  tool_name: string;
  request_id: string;
  input_json: string;
  result_json: string;
  created_at: number;
  /** 実行時のactiveRole。header導入前の行と、headerなしの互換呼出しはnull。 */
  active_role: string | null;
};

/** Outcomeに相関付いたStory・Taskの変更へ付ける相関。 */
export type EntityCorrelation = { id: string; outcome_ref: string | null; correlation_id: string | null };

type StoryPatch = Partial<Pick<StoryRecord, "title" | "description" | "status" | "sort_order" | "updated_at">>;
type TaskPatch = Partial<
  Pick<
    TaskRecord,
    "title" | "description" | "status" | "assignee" | "reject_reason" | "resume_source_status" | "sort_order" | "updated_at"
  >
>;
type ClaimPatch = Partial<Pick<TaskClaimRecord, "state" | "renewed_at" | "expires_at" | "released_at" | "release_reason">>;

/**
 * Project Role Grant（Accessが所有）の読取。Claim・状態遷移と同じtransactionで検査するため、storeが束ねて渡す。
 */
export interface ProjectGrantReader {
  /** PrincipalがProjectで持つRole。Grantが無ければ空。 */
  listRoles(projectId: string, principalId: string): Promise<string[]>;
}

/** Project（Directionが所有）の状態の読取。archivedのProjectでは新しい活動を始めない。 */
export interface ProjectStateReader {
  exists(projectId: string): Promise<boolean>;
  isArchived(projectId: string): Promise<boolean>;
}

/**
 * Workのrecordの読み書き（Unit of Work）。`transaction`の中で受け取ったstoreの操作は、同じtransactionで実行される。
 * Project状態・Grantの読取もそのtransactionに含める（SQLiteでは接続を1本で共有するため、外で読まない）。
 */
export interface WorkStore {
  transaction<T>(work: (store: WorkStore) => Promise<T>): Promise<T>;

  readonly grants: ProjectGrantReader;
  readonly projects: ProjectStateReader;

  findStory(storyId: string): Promise<StoryRecord | null>;
  findStoryInProject(projectId: string, storyId: string): Promise<StoryRecord | null>;
  findStoryByCorrelation(projectId: string, correlationId: string): Promise<StoryRecord | null>;
  /** `sort_order`・`created_at`の昇順。 */
  listStories(projectId: string, status?: string): Promise<StoryRecord[]>;
  /** `sort_order`・`created_at`の昇順。 */
  listStoriesByOutcome(projectId: string, outcomeId: string): Promise<StoryRecord[]>;
  maxStorySortOrder(projectId: string): Promise<number | null>;
  insertStory(story: StoryRecord): Promise<StoryRecord>;
  updateStory(storyId: string, patch: StoryPatch): Promise<StoryRecord>;
  /** 現在の状態が`from`のときだけ`to`へ更新する。更新したらtrue。 */
  updateStoryStatusIf(storyId: string, from: StoryStatus, to: StoryStatus, updatedAt: number): Promise<boolean>;

  findTask(taskId: string): Promise<TaskRecord | null>;
  findTaskInProject(projectId: string, taskId: string): Promise<TaskRecord | null>;
  findTaskByKey(storyId: string | null, taskKey: string): Promise<TaskRecord | null>;
  listTasks(projectId: string): Promise<TaskRecord[]>;
  listTasksOfStories(projectId: string, storyIds: string[]): Promise<TaskRecord[]>;
  /** `accepted`・`canceled`以外のTaskがStoryに残っているか。 */
  hasUnsettledTask(storyId: string): Promise<boolean>;
  maxTaskSortOrder(projectId: string): Promise<number | null>;
  insertTask(task: TaskRecord): Promise<TaskRecord>;
  updateTask(taskId: string, patch: TaskPatch): Promise<TaskRecord>;

  findClaim(claimId: string): Promise<TaskClaimRecord | null>;
  findActiveClaim(taskId: string): Promise<TaskClaimRecord | null>;
  listActiveClaims(projectId: string): Promise<TaskClaimRecord[]>;
  /** Taskの有効なClaimは1件だけ。既に有効なClaimがあれば保存せずfalse。 */
  insertClaim(claim: TaskClaimRecord): Promise<boolean>;
  /** `onlyActive`なら、有効（`active`）なClaimだけを更新する。 */
  updateClaim(claimId: string, patch: ClaimPatch, options?: { onlyActive?: boolean }): Promise<void>;

  /** `created_at`の昇順。 */
  listTaskComments(taskId: string): Promise<TaskCommentRecord[]>;
  insertTaskComment(comment: TaskCommentRecord): Promise<void>;
  hasClaimComment(taskId: string, claimId: string, principalId: string): Promise<boolean>;

  /** 追記したChangeの`cursor`を返す。 */
  appendChange(change: Omit<ChangeRecord, "cursor">): Promise<number>;
  /** 最新の`TASK_COMPLETED`を記録したPrincipal。 */
  findLatestCompleter(taskId: string): Promise<string | null>;
  /** Projectの`TASK_COMPLETED`を新しい順に返す。 */
  listCompletions(projectId: string): Promise<Pick<ChangeRecord, "entity_id" | "principal_id">[]>;
  /** `cursor`の昇順。 */
  listEntityChanges(projectId: string, entityId: string): Promise<ChangeRecord[]>;
  /** `afterCursor`より後を`cursor`の昇順で`limit`件。 */
  listChangesAfter(projectId: string, afterCursor: number, limit: number): Promise<ChangeRecord[]>;
  /** `beforeCursor`より前（nullなら最新から）を`cursor`の降順で`limit`件。 */
  listChangesBefore(projectId: string, beforeCursor: number | null, limit: number): Promise<ChangeRecord[]>;
  /** Project（`entityIds`を渡せばそのentity）の最新cursor。無ければ0。 */
  maxChangeCursor(projectId: string, entityIds?: string[]): Promise<number>;
  /** Story自身と、Story配下のTaskの相関（`outcome_ref`・`correlation_id`）。 */
  listEntityCorrelations(projectId: string, entityIds: string[]): Promise<EntityCorrelation[]>;

  findReceipt(principalId: string, toolName: string, requestId: string): Promise<CommandReceiptRecord | null>;
  insertReceipt(receipt: CommandReceiptRecord): Promise<void>;
}
