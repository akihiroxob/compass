import { outcomeCorrelationId } from "@compass/direction";
import { ProjectArchivedError } from "@compass/organization";
import { ConflictError, NotFoundError, ValidationError } from "@compass/shared";
import { StoryStatus } from "../domain/StoryStatus.ts";
import { TaskStatus, type TaskStatus as TaskStatusValue } from "../domain/TaskStatus.ts";
import { WorkRole } from "../domain/WorkRole.ts";
import { CoordinationError } from "./error/CoordinationError.ts";
import type {
  DirectionReferenceLookupPort,
  OutcomeReferenceSnapshot,
  RepositoryReference,
} from "./port/DirectionReferenceLookupPort.ts";
import type { ChangeRecord, StoryRecord, TaskClaimRecord, TaskRecord, WorkStore } from "./port/WorkStore.ts";

export type TaskAvailability = "work" | "review" | "acceptance";

export type ListTaskFilter = {
  status?: TaskStatusValue[];
  availableFor?: TaskAvailability;
  storyId?: string;
};

export type ClaimResult = {
  claimId: string;
  taskId: string;
  principalId: string;
  state: "active";
  acquiredAt: number;
  expiresAt: number;
  taskStatus: TaskStatusValue;
};

type Clock = () => number;

type ReceiptInput = Record<string, unknown>;
/** `operator`はHuman向けWeb UIからの介入（Task 46）。Agent PrincipalのRoleではない。 */
type ActivityActorRole = "worker" | "reviewer" | "manager" | "operator";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

type EditableFields = { title: string; description: string | null; sortOrder: number };
type FieldChanges = Partial<{ [K in keyof EditableFields]: { from: EditableFields[K]; to: EditableFields[K] } }>;

/** Story・Task編集の変更前後。変わった項目だけを返し、何も変わらなければ`null`（編集Changeを記録しない）。 */
const diffEditableFields = (before: EditableFields, after: EditableFields): FieldChanges | null => {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  for (const key of ["title", "description", "sortOrder"] as const) {
    if (before[key] !== after[key]) changes[key] = { from: before[key], to: after[key] };
  }
  return Object.keys(changes).length > 0 ? (changes as FieldChanges) : null;
};

const parseSnapshot = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));

const storyDto = (row: StoryRecord) => ({
  id: row.id,
  projectId: row.project_id,
  title: row.title,
  description: row.description,
  status: row.status,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  outcomeId: row.outcome_ref,
  originDecisionId: row.origin_decision_id,
  successCriteria: parseSnapshot<OutcomeReferenceSnapshot["successCriteria"]>(row.success_criteria_snapshot),
  constraints: parseSnapshot<string[]>(row.constraints_snapshot),
  repository: parseSnapshot<RepositoryReference>(row.repository_snapshot),
  correlationId: row.correlation_id,
});

const optionalId = (value: string | undefined, field: string): string | null => {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (!trimmed) throw new CoordinationError("INVALID_INPUT", `${field} must not be blank`);
  return trimmed;
};

const maxCorrelationIdLength = 200;
const maxTaskKeyLength = 200;

const issuedTaskDto = (row: TaskRecord) => ({
  id: row.id,
  projectId: row.project_id,
  storyId: row.story_id,
  title: row.title,
  description: row.description,
  status: row.status,
  sortOrder: row.sort_order,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  taskKey: row.task_key,
});

export type IssueTaskInput = {
  projectId: string;
  storyId?: string;
  title: string;
  description?: string;
  /**
   * Story内で一意なTaskの論理ID。同じkeyの再送は、requestIdが異なっても内容が同じなら既存Taskを返す。
   * 相関ID付き（Outcome handoff）Storyの配下では必須。手動起票では任意で、旧WachaのrequestId契約を維持する。
   */
  taskKey?: string;
};

export type IssueStoryInput = {
  projectId: string;
  title: string;
  description?: string;
  /** DirectionのOutcome。指定するとsnapshot（固定Success Criteria・Constraints・origin Decision）を保存する。 */
  outcomeId?: string;
  /** Project登録済みRepository。実際のcheckoutはRuntime / Agentの責務。 */
  repositoryId?: string;
  /** Project内で一意なhandoffの相関ID。`outcomeId`があれば既定は`outcome:{outcomeId}`。 */
  correlationId?: string;
};

export class TaskCoordinationService {
  private readonly claimTtlMs: number;

  constructor(
    private readonly store: WorkStore,
    /** Story作成時のOutcome・Repository参照だけに使う読取専用ポート。Direction側のtableは直接読まない。 */
    private readonly directionReferences: DirectionReferenceLookupPort,
    private readonly clock: Clock = () => Date.now(),
    claimTtlMs = Number(process.env.COMPASS_CLAIM_TTL_MS ?? 30 * 60 * 1000),
    /**
     * 操作Contextに固定したRole（`X-Compass-Active-Role`）。nullは互換の「操作ごとに必要Roleを検査」。
     * 指定時はそのRoleのGrantだけで認可し、同じPrincipalの他Grantを合算しない。
     */
    private readonly activeRole: string | null = null,
  ) {
    if (!Number.isFinite(claimTtlMs) || claimTtlMs <= 0) {
      throw new RangeError("COMPASS_CLAIM_TTL_MS must be a positive number");
    }
    this.claimTtlMs = claimTtlMs;
  }

  /** 同じstore・時刻源で、認可をactiveRoleのGrantだけに固定したserviceを返す。 */
  forActiveRole(activeRole: string): TaskCoordinationService {
    return new TaskCoordinationService(this.store, this.directionReferences, this.clock, this.claimTtlMs, activeRole);
  }

  /** 認可に使うRole。activeRoleがあれば、それを持つ場合だけそのRoleに絞る。 */
  private async grantedRoles(store: WorkStore, projectId: string, principalId: string): Promise<string[]> {
    const roles = (await store.grants.listRoles(projectId, principalId))
      .filter((role) => Object.values(WorkRole).some((candidate) => candidate === role));
    return this.activeRole === null ? roles : roles.filter((role) => role === this.activeRole);
  }

  private requiredText(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new CoordinationError("INVALID_INPUT", `${field} is required`);
    }
    return trimmed;
  }

  private async requireRole(
    store: WorkStore,
    projectId: string,
    principalId: string,
    role: WorkRole,
  ): Promise<void> {
    if (!(await this.grantedRoles(store, projectId, principalId)).includes(role)) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} does not have ${role} role for project ${projectId}`,
      );
    }
  }

  private async requireOneOfRoles(
    store: WorkStore,
    projectId: string,
    principalId: string,
    roles: WorkRole[],
  ): Promise<WorkRole> {
    const granted = await this.grantedRoles(store, projectId, principalId);
    const role = roles.find((candidate) => granted.includes(candidate));
    if (!role) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} does not have one of the required roles (${roles.join(", ")}) for project ${projectId}`,
      );
    }
    return role;
  }

  private async requireAnyRole(
    store: WorkStore,
    projectId: string,
    principalId: string,
  ): Promise<void> {
    if ((await this.grantedRoles(store, projectId, principalId)).length === 0) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} has no role for project ${projectId}`,
      );
    }
  }

  async listStories(principalId: string, projectId: string, status?: string) {
    await this.requireAnyRole(this.store, projectId, principalId);
    return this.listStoriesOfProject(projectId, status);
  }

  /** 共有の根（project）の存在確認。archivedも存在として扱う。 */
  async projectExists(projectId: string): Promise<boolean> {
    return this.store.projects.exists(projectId);
  }

  /** 認可済みの呼出し元（Human向けWeb APIのMembership認可）だけが使う。Role Grantは検査しない。 */
  async listStoriesOfProject(projectId: string, status?: string) {
    const rows = await this.store.listStories(projectId, status);
    return { stories: rows.map(storyDto) };
  }

  async listTaskComments(principalId: string, taskId: string) {
    const task = await this.getTask(this.store, taskId);
    await this.requireAnyRole(this.store, task.project_id, principalId);
    return this.readTaskComments(taskId);
  }

  private async readTaskComments(taskId: string) {
    const rows = await this.store.listTaskComments(taskId);
    return {
      comments: rows.map((row) => ({
        id: row.id,
        taskId: row.task_id,
        body: row.body,
        author: row.author,
        principalId: row.principal_id,
        claimId: row.claim_id,
        createdAt: row.created_at,
      })),
    };
  }

  private async getTask(store: WorkStore, taskId: string) {
    const task = await store.findTask(taskId);
    if (!task) {
      throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} was not found`);
    }
    return task;
  }

  /** archivedのProjectでは新しい活動（Story・Task起票、work Claim）を始めない。存在しないProjectは呼び出し前のGrant検査で拒否済み。 */
  private async assertProjectActive(store: WorkStore, projectId: string): Promise<void> {
    if (await store.projects.isArchived(projectId)) throw new ProjectArchivedError(projectId);
  }

  private async getActiveClaim(store: WorkStore, taskId: string) {
    return store.findActiveClaim(taskId);
  }

  private async appendChange(
    store: WorkStore,
    input: {
      projectId: string;
      type: string;
      entityId: string;
      principalId: string;
      claimId?: string | null;
      payload: Record<string, unknown>;
      occurredAt: number;
    },
  ): Promise<number> {
    return store.appendChange({
      project_id: input.projectId,
      type: input.type,
      entity_id: input.entityId,
      principal_id: input.principalId,
      claim_id: input.claimId ?? null,
      payload: JSON.stringify(input.payload),
      occurred_at: input.occurredAt,
    });
  }

  /** Story・Taskの編集で内容が変わったときだけ、編集Change（`STORY_EDITED` / `TASK_EDITED`）を同じtransactionで追記する。 */
  private async appendEditChange(
    store: WorkStore,
    input: {
      projectId: string;
      type: "STORY_EDITED" | "TASK_EDITED";
      entityId: string;
      principalId: string;
      actorRole: ActivityActorRole;
      before: EditableFields;
      after: EditableFields;
      occurredAt: number;
    },
  ): Promise<void> {
    const changes = diffEditableFields(input.before, input.after);
    if (!changes) return;
    await this.appendChange(store, {
      projectId: input.projectId,
      type: input.type,
      entityId: input.entityId,
      principalId: input.principalId,
      payload: { actorRole: input.actorRole, changes },
      occurredAt: input.occurredAt,
    });
  }

  private async expireClaim(
    store: WorkStore,
    claim: TaskClaimRecord,
    projectId: string,
    observedBy: string,
    actorRole: ActivityActorRole,
    now: number,
  ): Promise<void> {
    await store.updateClaim(
      claim.id,
      { state: "expired", released_at: now, release_reason: "lease_expired" },
      { onlyActive: true },
    );
    await this.appendChange(store, {
      projectId,
      type: "CLAIM_EXPIRED",
      entityId: claim.task_id,
      principalId: observedBy,
      claimId: claim.id,
      payload: { actorRole, claimPrincipalId: claim.principal_id, expiresAt: claim.expires_at },
      occurredAt: now,
    });
  }

  private async withReceipt<T>(
    store: WorkStore,
    principalId: string,
    toolName: string,
    requestId: string,
    input: ReceiptInput,
    execute: () => Promise<T>,
  ): Promise<T> {
    const inputJson = JSON.stringify(canonicalize(input));
    const existing = await store.findReceipt(principalId, toolName, requestId);
    if (existing) {
      // 別のactiveRoleでの再送に既存結果を返すと、Roleの制約を回避できる。互換の既存行（NULL）とheaderありも別扱い。
      if ((existing.active_role ?? null) !== this.activeRole) {
        throw new CoordinationError(
          "IDEMPOTENCY_CONFLICT",
          `requestId ${requestId} was already used with a different activeRole`,
        );
      }
      if (existing.input_json !== inputJson) {
        throw new CoordinationError(
          "IDEMPOTENCY_CONFLICT",
          `requestId ${requestId} was already used with different input`,
        );
      }
      return JSON.parse(existing.result_json) as T;
    }

    const result = await execute();
    await store.insertReceipt({
      principal_id: principalId,
      tool_name: toolName,
      request_id: requestId,
      input_json: inputJson,
      result_json: JSON.stringify(result),
      created_at: this.clock(),
      active_role: this.activeRole,
    });
    return result;
  }

  private claimResult(claim: TaskClaimRecord, taskStatus: TaskStatusValue): ClaimResult {
    return {
      claimId: claim.id,
      taskId: claim.task_id,
      principalId: claim.principal_id,
      state: "active",
      acquiredAt: claim.acquired_at,
      expiresAt: claim.expires_at,
      taskStatus,
    };
  }

  private async insertClaim(
    store: WorkStore,
    taskId: string,
    principalId: string,
    now: number,
  ): Promise<TaskClaimRecord> {
    const claim: TaskClaimRecord = {
      id: crypto.randomUUID(),
      task_id: taskId,
      principal_id: principalId,
      state: "active",
      acquired_at: now,
      renewed_at: null,
      expires_at: now + this.claimTtlMs,
      released_at: null,
      release_reason: null,
    };
    if (!(await store.insertClaim(claim))) {
      throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} was claimed concurrently`);
    }
    return claim;
  }

  private async latestCompleter(store: WorkStore, taskId: string): Promise<string | null> {
    return store.findLatestCompleter(taskId);
  }

  async listTasks(
    principalId: string,
    projectId: string,
    filter?: ListTaskFilter,
    limit?: number,
  ) {
    if (filter?.status && filter.availableFor) {
      throw new CoordinationError(
        "INVALID_FILTER_COMBINATION",
        "status and availableFor cannot be used together",
      );
    }
    await this.requireAnyRole(this.store, projectId, principalId);
    return this.buildTaskList(projectId, principalId, filter, limit);
  }

  /**
   * 認可済みの呼出し元（Human向けWeb APIのMembership認可）だけが使う。Role Grantは検査しない。
   * `availableFor`はAgent PrincipalのRoleに依存するため受け付けない。
   */
  async listTasksOfProject(projectId: string, filter?: Pick<ListTaskFilter, "status" | "storyId">) {
    return this.buildTaskList(projectId, null, filter);
  }

  /**
   * 認可済みの呼出し元（Human向けWeb APIのMembership認可）だけが使う。Task本体（一覧と同じ形）、所属Story、
   * Comment、当該TaskのChangeを返す。別ProjectのTask IDは存在しないものとして`null`を返す。
   */
  async getTaskDetailOfProject(projectId: string, taskId: string) {
    const row = await this.store.findTaskInProject(projectId, taskId);
    if (!row) return null;
    const [list, story, { comments }, changes] = await Promise.all([
      this.buildTaskList(projectId, null),
      row.story_id ? this.store.findStory(row.story_id) : Promise.resolve(null),
      this.readTaskComments(taskId),
      this.store.listEntityChanges(projectId, taskId),
    ]);
    const task = list.tasks.find((candidate) => candidate.id === taskId);
    if (!task) return null;
    return {
      task,
      story: story ? storyDto(story) : null,
      comments,
      changes: await this.decorateChanges(projectId, changes),
    };
  }

  private async buildTaskList(
    projectId: string,
    principalId: string | null,
    filter?: ListTaskFilter,
    limit?: number,
  ) {
    const now = this.clock();
    const [tasks, stories, claims, grantedRoles, completionChanges] = await Promise.all([
      this.store.listTasks(projectId),
      this.store.listStories(projectId),
      this.store.listActiveClaims(projectId),
      principalId === null ? Promise.resolve([]) : this.grantedRoles(this.store, projectId, principalId),
      this.store.listCompletions(projectId),
    ]);
    const storyOrders = new Map(stories.map((story) => [story.id, story.sort_order]));
    const activeClaims = new Map(claims.map((claim) => [claim.task_id, claim]));
    const roles = new Set<string>(grantedRoles);
    const latestCompleters = new Map<string, string>();
    for (const change of completionChanges) {
      if (!latestCompleters.has(change.entity_id)) {
        latestCompleters.set(change.entity_id, change.principal_id);
      }
    }

    const ordered = [...tasks].sort((a, b) => {
      const aPrimary = a.story_id ? (storyOrders.get(a.story_id) ?? Number.MAX_SAFE_INTEGER) : a.sort_order;
      const bPrimary = b.story_id ? (storyOrders.get(b.story_id) ?? Number.MAX_SAFE_INTEGER) : b.sort_order;
      return aPrimary - bPrimary || a.sort_order - b.sort_order || a.created_at - b.created_at;
    });

    const isAvailable = (task: (typeof tasks)[number]) => {
      const claim = activeClaims.get(task.id);
      const hasUnexpiredClaim = claim !== undefined && claim.expires_at > now;
      switch (filter?.availableFor) {
        case "work":
          return (
            roles.has(WorkRole.WORKER) &&
            (((task.status === TaskStatus.TODO || task.status === TaskStatus.REJECTED) &&
              !hasUnexpiredClaim) ||
              (task.status === TaskStatus.DOING && claim !== undefined && claim.expires_at <= now))
          );
        case "review":
          return (
            roles.has(WorkRole.REVIEWER) &&
            task.status === TaskStatus.IN_REVIEW &&
            !hasUnexpiredClaim &&
            latestCompleters.get(task.id) !== principalId
          );
        case "acceptance":
          return (
            roles.has(WorkRole.MANAGER) &&
            (task.status === TaskStatus.IN_REVIEW || task.status === TaskStatus.WAIT_ACCEPT) &&
            !hasUnexpiredClaim &&
            latestCompleters.get(task.id) !== principalId
          );
        default:
          return true;
      }
    };

    let selected = ordered.filter((task) => {
      if (filter?.storyId && task.story_id !== filter.storyId) return false;
      if (filter?.status && !filter.status.includes(task.status as TaskStatusValue)) return false;
      return isAvailable(task);
    });
    if (limit !== undefined) selected = selected.slice(0, limit);

    const taskDtos = selected.map((task) => {
      const claim = activeClaims.get(task.id);
      const unexpiredClaim = claim && claim.expires_at > now ? claim : null;
      return {
        id: task.id,
        projectId: task.project_id,
        storyId: task.story_id,
        title: task.title,
        description: task.description,
        status: task.status,
        assignee: unexpiredClaim?.principal_id ?? null,
        rejectReason: task.reject_reason,
        resumeSourceStatus: task.resume_source_status,
        createdAt: task.created_at,
        updatedAt: task.updated_at,
        sortOrder: task.sort_order,
        taskKey: task.task_key,
        activeClaim: unexpiredClaim
          ? {
              claimId: unexpiredClaim.id,
              principalId: unexpiredClaim.principal_id,
              expiresAt: unexpiredClaim.expires_at,
            }
          : null,
        reclaimable: task.status === TaskStatus.DOING && claim !== undefined && claim.expires_at <= now,
      };
    });

    const byStatus = Object.fromEntries(
      Object.values(TaskStatus).map((status) => [
        status,
        tasks.filter((task) => task.status === status).length,
      ]),
    ) as Record<TaskStatusValue, number>;
    return {
      summary: {
        total: tasks.length,
        byStatus,
        lastUpdatedAt: tasks.reduce<number | null>(
          (max, task) => (max === null || task.updated_at > max ? task.updated_at : max),
          null,
        ),
      },
      tasks: taskDtos,
    };
  }

  async claimTask(principalId: string, taskId: string, requestId: string): Promise<ClaimResult> {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "claim_task", requestId, { taskId }, async () => {
        const now = this.clock();
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.WORKER);
        await this.assertProjectActive(store, task.project_id);
        const currentClaim = await this.getActiveClaim(store, taskId);
        let reclaimingExpiredWork = false;
        if (currentClaim) {
          if (currentClaim.expires_at > now) {
            throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
          }
          reclaimingExpiredWork = task.status === TaskStatus.DOING;
          await this.expireClaim(store, currentClaim, task.project_id, principalId, "worker", now);
        }
        if (
          task.status !== TaskStatus.TODO &&
          task.status !== TaskStatus.REJECTED &&
          !(task.status === TaskStatus.DOING && reclaimingExpiredWork)
        ) {
          throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} is not available for work`);
        }
        const fromStatus = task.status;
        const claim = await this.insertClaim(store, taskId, principalId, now);
        await store.updateTask(taskId, {
            status: TaskStatus.DOING,
            assignee: null,
            resume_source_status:
              fromStatus === TaskStatus.REJECTED ? TaskStatus.REJECTED : TaskStatus.TODO,
            updated_at: now,
          });
        if (task.story_id) {
          const story = await store.findStory(task.story_id);
          if (story?.status === StoryStatus.TODO) {
            await store.updateStory(task.story_id, { status: StoryStatus.DOING, updated_at: now });
            await this.appendChange(store, {
              projectId: task.project_id,
              type: "STORY_STARTED",
              entityId: task.story_id,
              principalId,
              claimId: claim.id,
              payload: { actorRole: "worker", fromStatus: StoryStatus.TODO, toStatus: StoryStatus.DOING },
              occurredAt: now,
            });
          }
        }
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_CLAIMED",
          entityId: taskId,
          principalId,
          claimId: claim.id,
          payload: {
            actorRole: "worker",
            claimCommand: "claim_task",
            fromStatus,
            toStatus: TaskStatus.DOING,
            path: reclaimingExpiredWork ? "expired_claim_recovery" : "normal",
          },
          occurredAt: now,
        });
        return this.claimResult(claim, TaskStatus.DOING);
      }),
    );
  }

  async claimReview(principalId: string, taskId: string, requestId: string): Promise<ClaimResult> {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "claim_review", requestId, { taskId }, async () => {
        const now = this.clock();
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.REVIEWER);
        const currentClaim = await this.getActiveClaim(store, taskId);
        if (currentClaim) {
          if (currentClaim.expires_at > now) {
            throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
          }
          await this.expireClaim(store, currentClaim, task.project_id, principalId, "reviewer", now);
        }
        if (task.status !== TaskStatus.IN_REVIEW) {
          throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} is not available for review`);
        }
        if ((await this.latestCompleter(store, taskId)) === principalId) {
          throw new CoordinationError(
            "SELF_REVIEW_NOT_ALLOWED",
            `Principal ${principalId} cannot review its own completed work`,
          );
        }
        const claim = await this.insertClaim(store, taskId, principalId, now);
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_CLAIMED",
          entityId: taskId,
          principalId,
          claimId: claim.id,
          payload: { actorRole: "reviewer", claimCommand: "claim_review", fromStatus: task.status, toStatus: task.status },
          occurredAt: now,
        });
        return this.claimResult(claim, TaskStatus.IN_REVIEW);
      }),
    );
  }

  /**
   * 受入Claimの取得。Agent（manager）はRole検査と自己受入の禁止を行う。Human operatorはAgent Principalではないため、
   * どちらも行わない（認可はHuman Membershipで入口が済ませる）。
   */
  private async claimAcceptanceCore(
    store: WorkStore,
    principalId: string,
    taskId: string,
    actorRole: "manager" | "operator",
  ): Promise<ClaimResult> {
    const now = this.clock();
    const task = await this.getTask(store, taskId);
    if (actorRole === "manager") {
      await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
    }
    const currentClaim = await this.getActiveClaim(store, taskId);
    if (currentClaim) {
      if (currentClaim.expires_at > now) {
        throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
      }
      await this.expireClaim(store, currentClaim, task.project_id, principalId, actorRole, now);
    }
    if (task.status !== TaskStatus.IN_REVIEW && task.status !== TaskStatus.WAIT_ACCEPT) {
      throw new CoordinationError(
        "TASK_NOT_CLAIMABLE",
        `Task ${taskId} is not available for acceptance`,
      );
    }
    if (actorRole === "manager" && (await this.latestCompleter(store, taskId)) === principalId) {
      throw new CoordinationError(
        "SELF_ACCEPTANCE_NOT_ALLOWED",
        `Principal ${principalId} cannot accept its own completed work`,
      );
    }
    const fromStatus = task.status;
    const claim = await this.insertClaim(store, taskId, principalId, now);
    if (fromStatus === TaskStatus.IN_REVIEW) {
      await store.updateTask(taskId, { status: TaskStatus.WAIT_ACCEPT, updated_at: now });
    }
    await this.appendChange(store, {
      projectId: task.project_id,
      type: "TASK_CLAIMED",
      entityId: taskId,
      principalId,
      claimId: claim.id,
      payload: {
        actorRole,
        claimCommand: "claim_acceptance",
        fromStatus,
        toStatus: TaskStatus.WAIT_ACCEPT,
        // Reviewer工程を経ずに受入へ進んだ場合、誰が省いたかを残す（Human operatorは`operator_direct_review`）。
        path: fromStatus === TaskStatus.IN_REVIEW ? `${actorRole}_direct_review` : "reviewer_approved",
      },
      occurredAt: now,
    });
    return this.claimResult(claim, TaskStatus.WAIT_ACCEPT);
  }

  async claimAcceptance(
    principalId: string,
    taskId: string,
    requestId: string,
  ): Promise<ClaimResult> {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "claim_acceptance", requestId, { taskId }, () =>
        this.claimAcceptanceCore(store, principalId, taskId, "manager"),
      ),
    );
  }

  private async assertCurrentClaim(
    store: WorkStore,
    principalId: string,
    taskId: string,
    claimId: string,
  ) {
    const claim = await store.findClaim(claimId);
    if (!claim || claim.task_id !== taskId) {
      throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found for Task ${taskId}`);
    }
    if (claim.principal_id !== principalId) {
      throw new CoordinationError("CLAIM_NOT_OWNED", `Claim ${claimId} belongs to another Principal`);
    }
    if (claim.state !== "active" || claim.expires_at <= this.clock()) {
      throw new CoordinationError("CLAIM_EXPIRED", `Claim ${claimId} is no longer active`);
    }
    const current = await this.getActiveClaim(store, taskId);
    if (!current || current.id !== claimId) {
      throw new CoordinationError("CLAIM_EXPIRED", `Claim ${claimId} is not the current Task Claim`);
    }
    return claim;
  }

  async renewClaim(principalId: string, claimId: string) {
    return this.store.transaction(async (store) => {
      const claim = await store.findClaim(claimId);
      if (!claim) throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found`);
      await this.assertCurrentClaim(store, principalId, claim.task_id, claimId);
      const now = this.clock();
      const expiresAt = now + this.claimTtlMs;
      await store.updateClaim(claimId, { renewed_at: now, expires_at: expiresAt });
      return { claimId, taskId: claim.task_id, renewedAt: now, expiresAt };
    });
  }

  async releaseClaim(
    principalId: string,
    claimId: string,
    reason: string,
    requestId: string,
  ) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "release_claim", requestId, { claimId, reason }, async () => {
        const claim = await store.findClaim(claimId);
        if (!claim) throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found`);
        await this.assertCurrentClaim(store, principalId, claim.task_id, claimId);
        const task = await this.getTask(store, claim.task_id);
        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          throw new CoordinationError("INVALID_INPUT", "Release reason is required");
        }
        const now = this.clock();
        const actorRole: ActivityActorRole =
          task.status === TaskStatus.DOING
            ? "worker"
            : task.status === TaskStatus.IN_REVIEW
              ? "reviewer"
              : "manager";
        let taskStatus = task.status as TaskStatusValue;
        if (task.status === TaskStatus.DOING) {
          taskStatus = TaskStatus.TODO;
          await store.updateTask(task.id, {
              status: TaskStatus.TODO,
              assignee: null,
              resume_source_status: null,
              updated_at: now,
            });
        }
        await store.updateClaim(claimId, { state: "released", released_at: now, release_reason: trimmedReason });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "CLAIM_RELEASED",
          entityId: task.id,
          principalId,
          claimId,
          payload: { actorRole, reason: trimmedReason, taskStatus },
          occurredAt: now,
        });
        return { claimId, taskId: task.id, state: "released" as const, taskStatus };
      }),
    );
  }

  async addTaskComment(
    principalId: string,
    taskId: string,
    claimId: string,
    body: string,
    requestId: string,
  ) {
    return this.store.transaction(async (store) =>
      this.withReceipt(
        store,
        principalId,
        "add_task_comment",
        requestId,
        { taskId, claimId, body },
        async () => {
          await this.assertCurrentClaim(store, principalId, taskId, claimId);
          const task = await this.getTask(store, taskId);
          if (task.status === TaskStatus.DOING) {
            await this.requireRole(store, task.project_id, principalId, WorkRole.WORKER);
          } else if (task.status === TaskStatus.IN_REVIEW) {
            await this.requireRole(store, task.project_id, principalId, WorkRole.REVIEWER);
          } else if (task.status === TaskStatus.WAIT_ACCEPT) {
            await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
          } else {
            throw new CoordinationError(
              "INVALID_TASK_STATUS",
              `Task ${taskId} does not accept Claim-bound comments in ${task.status}`,
            );
          }
          const trimmedBody = body.trim();
          if (!trimmedBody) {
            throw new CoordinationError("INVALID_INPUT", "Comment body is required");
          }
          const now = this.clock();
          const id = crypto.randomUUID();
          await store.insertTaskComment({
            id,
            task_id: taskId,
            body: trimmedBody,
            author: principalId,
            principal_id: principalId,
            claim_id: claimId,
            created_at: now,
          });
          return {
            comment: {
              id,
              taskId,
              body: trimmedBody,
              author: principalId,
              principalId,
              claimId,
              createdAt: now,
            },
          };
        },
      ),
    );
  }

  async completeTask(principalId: string, taskId: string, claimId: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "complete_task", requestId, { taskId, claimId }, async () => {
        const claim = await this.assertCurrentClaim(store, principalId, taskId, claimId);
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.WORKER);
        if (task.status !== TaskStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not doing`);
        }
        if (!(await store.hasClaimComment(taskId, claimId, principalId))) {
          throw new CoordinationError(
            "INVALID_TASK_STATUS",
            "Record implementation and verification notes with add_task_comment before complete_task",
          );
        }
        const now = this.clock();
        await store.updateTask(taskId, {
            status: TaskStatus.IN_REVIEW,
            assignee: null,
            resume_source_status: null,
            updated_at: now,
          });
        await store.updateClaim(claim.id, { state: "completed", released_at: now, release_reason: "task_completed" });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_COMPLETED",
          entityId: taskId,
          principalId,
          claimId,
          payload: { actorRole: "worker", fromStatus: TaskStatus.DOING, toStatus: TaskStatus.IN_REVIEW },
          occurredAt: now,
        });
        return { taskId, claimId, status: TaskStatus.IN_REVIEW };
      }),
    );
  }

  async reviewedTask(principalId: string, taskId: string, claimId: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "reviewed_task", requestId, { taskId, claimId }, async () => {
        await this.assertCurrentClaim(store, principalId, taskId, claimId);
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.REVIEWER);
        if (task.status !== TaskStatus.IN_REVIEW) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not in_review`);
        }
        const now = this.clock();
        await store.updateTask(taskId, { status: TaskStatus.WAIT_ACCEPT, updated_at: now });
        await store.updateClaim(claimId, { state: "completed", released_at: now, release_reason: "task_reviewed" });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_REVIEWED",
          entityId: taskId,
          principalId,
          claimId,
          payload: { actorRole: "reviewer", fromStatus: TaskStatus.IN_REVIEW, toStatus: TaskStatus.WAIT_ACCEPT },
          occurredAt: now,
        });
        return { taskId, claimId, status: TaskStatus.WAIT_ACCEPT };
      }),
    );
  }

  private async syncStoryAfterAcceptance(
    store: WorkStore,
    projectId: string,
    storyId: string | null,
    principalId: string,
    claimId: string,
    actorRole: ActivityActorRole,
    now: number,
  ) {
    if (!storyId) return;
    if (!(await store.hasUnsettledTask(storyId))) {
      if (await store.updateStoryStatusIf(storyId, StoryStatus.DOING, StoryStatus.DONE, now)) {
        await this.appendChange(store, {
          projectId,
          type: "STORY_COMPLETED",
          entityId: storyId,
          principalId,
          claimId,
          payload: { actorRole, fromStatus: StoryStatus.DOING, toStatus: StoryStatus.DONE, path: "task_acceptance" },
          occurredAt: now,
        });
      }
    }
  }

  private async acceptTaskCore(
    store: WorkStore,
    principalId: string,
    taskId: string,
    claimId: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(store, taskId);
    if (task.status !== TaskStatus.WAIT_ACCEPT) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not wait_accept`);
    }
    const now = this.clock();
    await store.updateTask(taskId, {
        status: TaskStatus.ACCEPTED,
        reject_reason: null,
        resume_source_status: null,
        updated_at: now,
      });
    await store.updateClaim(claimId, { state: "completed", released_at: now, release_reason: "task_accepted" });
    await this.appendChange(store, {
      projectId: task.project_id,
      type: "TASK_ACCEPTED",
      entityId: taskId,
      principalId,
      claimId,
      payload: { actorRole, fromStatus: TaskStatus.WAIT_ACCEPT, toStatus: TaskStatus.ACCEPTED },
      occurredAt: now,
    });
    await this.syncStoryAfterAcceptance(
      store,
      task.project_id,
      task.story_id,
      principalId,
      claimId,
      actorRole,
      now,
    );
    return { taskId, claimId, status: TaskStatus.ACCEPTED };
  }

  async acceptTask(principalId: string, taskId: string, claimId: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "accept_task", requestId, { taskId, claimId }, async () => {
        await this.assertCurrentClaim(store, principalId, taskId, claimId);
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
        return this.acceptTaskCore(store, principalId, taskId, claimId, "manager");
      }),
    );
  }

  async rejectTask(
    principalId: string,
    taskId: string,
    claimId: string,
    reason: string,
    requestId: string,
  ) {
    return this.store.transaction(async (store) =>
      this.withReceipt(
        store,
        principalId,
        "reject_task",
        requestId,
        { taskId, claimId, reason },
        async () => {
          await this.assertCurrentClaim(store, principalId, taskId, claimId);
          const task = await this.getTask(store, taskId);
          let actorRole: ActivityActorRole;
          if (task.status === TaskStatus.IN_REVIEW) {
            await this.requireRole(store, task.project_id, principalId, WorkRole.REVIEWER);
            actorRole = "reviewer";
          } else if (task.status === TaskStatus.WAIT_ACCEPT) {
            await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
            actorRole = "manager";
          } else {
            throw new CoordinationError(
              "INVALID_TASK_STATUS",
              `Task ${taskId} is not reviewable`,
            );
          }
          return this.rejectTaskCore(store, principalId, taskId, claimId, reason, actorRole);
        },
      ),
    );
  }

  private async rejectTaskCore(
    store: WorkStore,
    principalId: string,
    taskId: string,
    claimId: string,
    reason: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(store, taskId);
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new CoordinationError("INVALID_INPUT", "Reject reason is required");
    }
    const now = this.clock();
    const fromStatus = task.status;
    await store.updateTask(taskId, {
        status: TaskStatus.REJECTED,
        reject_reason: trimmedReason,
        resume_source_status: null,
        updated_at: now,
      });
    await store.updateClaim(claimId, { state: "completed", released_at: now, release_reason: "task_rejected" });
    await this.appendChange(store, {
      projectId: task.project_id,
      type: "TASK_REJECTED",
      entityId: taskId,
      principalId,
      claimId,
      payload: { actorRole, fromStatus, toStatus: TaskStatus.REJECTED, reason: trimmedReason },
      occurredAt: now,
    });
    return { taskId, claimId, status: TaskStatus.REJECTED, rejectReason: trimmedReason };
  }

  private async cancelTaskCore(
    store: WorkStore,
    principalId: string,
    taskId: string,
    reason: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(store, taskId);
    if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.DOING) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not cancelable`);
    }
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new CoordinationError("INVALID_INPUT", "Cancel reason is required");
    }
    const now = this.clock();
    const claim = await this.getActiveClaim(store, taskId);
    if (claim) {
      await store.updateClaim(claim.id, { state: "released", released_at: now, release_reason: "task_canceled" });
    }
    await store.updateTask(taskId, {
        status: TaskStatus.CANCELED,
        assignee: null,
        resume_source_status: null,
        updated_at: now,
      });
    await this.appendChange(store, {
      projectId: task.project_id,
      type: "TASK_CANCELED",
      entityId: taskId,
      principalId,
      claimId: claim?.id ?? null,
      payload: { actorRole, fromStatus: task.status, toStatus: TaskStatus.CANCELED, reason: trimmedReason },
      occurredAt: now,
    });
    return { taskId, status: TaskStatus.CANCELED, reason: trimmedReason };
  }

  async cancelTask(principalId: string, taskId: string, reason: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "cancel_task", requestId, { taskId, reason }, async () => {
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
        return this.cancelTaskCore(store, principalId, taskId, reason, "manager");
      }),
    );
  }

  // ---- Human operator（Web UI）の介入（Task 46。docs/lv6-unification-design.md「Web UIの配置と移行順」U3）。 ----
  // 認可済みの呼出し元（Human MembershipのWeb API）だけが使う。`principalId`は入口がHumanから導出した値で、
  // 外部入力から任意の値を渡させない。Agentの自己review / 自己受入の禁止規則とは独立（HumanはAgent Principalではない）。

  /** 対象TaskがProjectに属し（別ProjectのTask IDは存在しない扱い）、Projectがactiveであること。 */
  private async getOperatorTask(store: WorkStore, projectId: string, taskId: string) {
    const task = await store.findTaskInProject(projectId, taskId);
    if (!task) throw new NotFoundError(`Task ${taskId} was not found in Project ${projectId}`);
    await this.assertProjectActive(store, projectId);
    return task;
  }

  /** `in_review` / `wait_accept`のTaskを受入Claimの取得と同じtransactionで受け入れる。Claim中（期限内）なら`CLAIM_CONFLICT`。 */
  async acceptTaskAsOperator(principalId: string, projectId: string, taskId: string) {
    return this.store.transaction(async (store) => {
      await this.getOperatorTask(store, projectId, taskId);
      const claim = await this.claimAcceptanceCore(store, principalId, taskId, "operator");
      return this.acceptTaskCore(store, principalId, taskId, claim.claimId, "operator");
    });
  }

  async rejectTaskAsOperator(principalId: string, projectId: string, taskId: string, reason: string) {
    return this.store.transaction(async (store) => {
      await this.getOperatorTask(store, projectId, taskId);
      if (!reason.trim()) throw new CoordinationError("INVALID_INPUT", "Reject reason is required");
      const claim = await this.claimAcceptanceCore(store, principalId, taskId, "operator");
      return this.rejectTaskCore(store, principalId, taskId, claim.claimId, reason, "operator");
    });
  }

  /** `todo` / `doing`のTaskを取り消す。Agentの有効なClaimは同じtransactionで解放する（Managerの`cancel_task`と同じ）。 */
  async cancelTaskAsOperator(principalId: string, projectId: string, taskId: string, reason: string) {
    return this.store.transaction(async (store) => {
      await this.getOperatorTask(store, projectId, taskId);
      return this.cancelTaskCore(store, principalId, taskId, reason, "operator");
    });
  }

  /**
   * HumanのComment。Claimに紐づかない（`claimId`は`null`）ため、Agentの`complete_task`が要求する作業記録にはならない。
   * Change Logには種別を足さず（MCP `list_changes`の契約を変えない）、`task_comment`に投稿者の`principalId`を残す。
   */
  async addTaskCommentAsOperator(principalId: string, projectId: string, taskId: string, body: string) {
    return this.store.transaction(async (store) => {
      await this.getOperatorTask(store, projectId, taskId);
      const trimmedBody = body.trim();
      if (!trimmedBody) throw new CoordinationError("INVALID_INPUT", "Comment body is required");
      const comment = {
        id: crypto.randomUUID(),
        task_id: taskId,
        body: trimmedBody,
        author: principalId,
        principal_id: principalId,
        claim_id: null,
        created_at: this.clock(),
      };
      await store.insertTaskComment(comment);
      return {
        comment: {
          id: comment.id,
          taskId,
          body: trimmedBody,
          author: principalId,
          principalId,
          claimId: null,
          createdAt: comment.created_at,
        },
      };
    });
  }

  // ---- Human operator（Web UI）の手動起票・編集（Task 47。U4）。認可はMembership（`execution.plan`）が入口で済ませる。 ----
  // Outcome handoff（相関ID付きStory・`taskKey`付きTask）はManagerの`issue_story` / `issue_task`の再送で同じ内容へ収束させる
  // 契約のため、Humanは作成・編集しない（配下へのTask追加も含む）。編集はMCPの`edit_story` / `edit_task`と同じく、内容が変わったときだけ編集Changeを残す。

  /** 対象StoryがProjectに属し（別ProjectのStory IDは存在しない扱い）、Projectがactiveであること。 */
  private async getOperatorStory(store: WorkStore, projectId: string, storyId: string) {
    const story = await store.findStoryInProject(projectId, storyId);
    if (!story) throw new NotFoundError(`Story ${storyId} was not found in Project ${projectId}`);
    await this.assertProjectActive(store, projectId);
    return story;
  }

  /** Human手動起票の対象にできるStory（手動起票で、完了・取消していない）か。 */
  private assertStoryEditableByOperator(story: StoryRecord, action: string): void {
    if (story.correlation_id !== null) {
      throw new ConflictError(`Story ${story.id} is an Outcome handoff Story; ${action} is managed by the Manager`, {
        conflict: "HANDOFF_MANAGED",
      });
    }
    if (story.status === StoryStatus.DONE || story.status === StoryStatus.CANCELED) {
      throw new ConflictError(`Story ${story.id} is ${story.status}`, { conflict: "STORY_CLOSED" });
    }
  }

  async issueStoryAsOperator(principalId: string, projectId: string, input: { title: string; description: string | null }) {
    return this.store.transaction(async (store) => {
      await this.assertProjectActive(store, projectId);
      const maxSortOrder = await store.maxStorySortOrder(projectId);
      const now = this.clock();
      const id = crypto.randomUUID();
      const row = await store.insertStory({
          id,
          project_id: projectId,
          title: this.requiredText(input.title, "Story title"),
          description: input.description?.trim() || null,
          status: StoryStatus.TODO,
          sort_order: (maxSortOrder ?? 0) + 1,
          created_at: now,
          updated_at: now,
          outcome_ref: null,
          origin_decision_id: null,
          success_criteria_snapshot: null,
          constraints_snapshot: null,
          repository_snapshot: null,
          correlation_id: null,
        });
      await this.appendChange(store, {
        projectId,
        type: "STORY_CREATED",
        entityId: id,
        principalId,
        payload: { actorRole: "operator", status: StoryStatus.TODO },
        occurredAt: now,
      });
      return storyDto(row);
    });
  }

  async editStoryAsOperator(
    principalId: string,
    projectId: string,
    storyId: string,
    input: { title: string; description: string | null },
  ) {
    return this.store.transaction(async (store) => {
      const story = await this.getOperatorStory(store, projectId, storyId);
      this.assertStoryEditableByOperator(story, "editing");
      const now = this.clock();
      const row = await store.updateStory(storyId, { title: this.requiredText(input.title, "Story title"), description: input.description?.trim() || null, updated_at: now });
      await this.appendEditChange(store, {
        projectId,
        type: "STORY_EDITED",
        entityId: storyId,
        principalId,
        actorRole: "operator",
        before: { title: story.title, description: story.description, sortOrder: story.sort_order },
        after: { title: row.title, description: row.description, sortOrder: row.sort_order },
        occurredAt: now,
      });
      return storyDto(row);
    });
  }

  async issueTaskAsOperator(
    principalId: string,
    projectId: string,
    input: { storyId: string | null; title: string; description: string | null },
  ) {
    return this.store.transaction(async (store) => {
      await this.assertProjectActive(store, projectId);
      if (input.storyId !== null) {
        const story = await store.findStoryInProject(projectId, input.storyId);
        // 別ProjectのStory IDは存在しないStoryと区別しない（orphan・別Projectへの紐付けを作らない）。
        if (!story) {
          throw new ValidationError("Task input is invalid", [{ path: "storyId", message: "Story was not found in the Project" }]);
        }
        this.assertStoryEditableByOperator(story, "adding Tasks");
      }
      const maxSortOrder = await store.maxTaskSortOrder(projectId);
      const now = this.clock();
      const id = crypto.randomUUID();
      const row = await store.insertTask({
          id,
          project_id: projectId,
          story_id: input.storyId,
          title: this.requiredText(input.title, "Task title"),
          description: input.description?.trim() || null,
          status: TaskStatus.TODO,
          assignee: null,
          reject_reason: null,
          resume_source_status: null,
          sort_order: (maxSortOrder ?? 0) + 1,
          created_at: now,
          updated_at: now,
          task_key: null,
        });
      await this.appendChange(store, {
        projectId,
        type: "TASK_CREATED",
        entityId: id,
        principalId,
        payload: { actorRole: "operator", status: TaskStatus.TODO, storyId: input.storyId },
        occurredAt: now,
      });
      return issuedTaskDto(row);
    });
  }

  /** 受入済み・取消済みのTaskと、Outcome handoffのTask（`taskKey`付き・相関ID付きStory配下）は編集しない。 */
  async editTaskAsOperator(
    principalId: string,
    projectId: string,
    taskId: string,
    input: { title: string; description: string | null },
  ) {
    return this.store.transaction(async (store) => {
      const task = await this.getOperatorTask(store, projectId, taskId);
      const story = task.story_id
        ? await store.findStory(task.story_id)
        : null;
      if (task.task_key !== null || (story?.correlation_id ?? null) !== null) {
        throw new ConflictError(`Task ${taskId} is an Outcome handoff Task; editing is managed by the Manager`, {
          conflict: "HANDOFF_MANAGED",
        });
      }
      if (task.status === TaskStatus.ACCEPTED || task.status === TaskStatus.CANCELED) {
        throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is ${task.status}`);
      }
      const now = this.clock();
      const row = await store.updateTask(taskId, { title: this.requiredText(input.title, "Task title"), description: input.description?.trim() || null, updated_at: now });
      await this.appendEditChange(store, {
        projectId,
        type: "TASK_EDITED",
        entityId: taskId,
        principalId,
        actorRole: "operator",
        before: { title: task.title, description: task.description, sortOrder: task.sort_order },
        after: { title: row.title, description: row.description, sortOrder: row.sort_order },
        occurredAt: now,
      });
      return issuedTaskDto(row);
    });
  }

  async issueTask(principalId: string, input: IssueTaskInput, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "issue_task", requestId, input, async () => {
        const actorRole = await this.requireOneOfRoles(store, input.projectId, principalId, [
          WorkRole.MANAGER,
          WorkRole.REVIEWER,
          WorkRole.WORKER,
        ]);
        await this.assertProjectActive(store, input.projectId);
        const title = this.requiredText(input.title, "Task title");
        const description = input.description?.trim() || null;
        const taskKey = optionalId(input.taskKey, "taskKey");
        if (taskKey !== null && taskKey.length > maxTaskKeyLength) {
          throw new CoordinationError("INVALID_INPUT", `taskKey must be ${maxTaskKeyLength} characters or fewer`);
        }
        if (taskKey !== null && !input.storyId) {
          throw new CoordinationError("INVALID_INPUT", "taskKey requires storyId");
        }
        let story: { correlation_id: string | null; outcome_ref: string | null } | undefined;
        if (input.storyId) {
          story = (await store.findStoryInProject(input.projectId, input.storyId)) ?? undefined;
          if (!story) {
            throw new CoordinationError("INVALID_INPUT", "Story was not found in the Project");
          }
          // Outcome handoffのStory配下は、Manager再起動後の別requestIdでも同じTaskへ収束させるため論理IDを必須にする。
          if (story.correlation_id !== null && taskKey === null) {
            throw new CoordinationError(
              "INVALID_INPUT",
              "taskKey is required for Tasks of a Story with a correlationId (Outcome handoff)",
            );
          }
        }
        if (taskKey !== null) {
          const existing = await store.findTaskByKey(input.storyId ?? null, taskKey);
          if (existing) {
            if (existing.title !== title || existing.description !== description) {
              throw new CoordinationError(
                "IDEMPOTENCY_CONFLICT",
                `taskKey ${taskKey} was already used with a different Task in the Story`,
              );
            }
            return issuedTaskDto(existing);
          }
        }
        const now = this.clock();
        const maxSortOrder = await store.maxTaskSortOrder(input.projectId);
        const id = crypto.randomUUID();
        const sortOrder = (maxSortOrder ?? 0) + 1;
        const row = await store.insertTask({
            id,
            project_id: input.projectId,
            story_id: input.storyId ?? null,
            title,
            description,
            status: TaskStatus.TODO,
            assignee: null,
            reject_reason: null,
            resume_source_status: null,
            sort_order: sortOrder,
            created_at: now,
            updated_at: now,
            task_key: taskKey,
          });
        await this.appendChange(store, {
          projectId: input.projectId,
          type: "TASK_CREATED",
          entityId: id,
          principalId,
          payload: {
            actorRole,
            status: TaskStatus.TODO,
            storyId: input.storyId ?? null,
            ...(taskKey === null ? {} : { taskKey }),
            // Directionから来たStoryの子Taskは、Change Logから相関IDとOutcomeを辿れるようにする。
            ...(story?.correlation_id ? { correlationId: story.correlation_id } : {}),
            ...(story?.outcome_ref ? { outcomeId: story.outcome_ref } : {}),
          },
          occurredAt: now,
        });
        return issuedTaskDto(row);
      }),
    );
  }

  async editTask(
    principalId: string,
    input: {
      projectId: string;
      taskId: string;
      title: string;
      description?: string;
      sortOrder?: number;
    },
    requestId: string,
  ) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "edit_task", requestId, input, async () => {
        await this.requireRole(store, input.projectId, principalId, WorkRole.MANAGER);
        const task = await this.getTask(store, input.taskId);
        if (task.project_id !== input.projectId) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Task does not belong to the Project");
        }
        const title = this.requiredText(input.title, "Task title");
        const now = this.clock();
        await store.updateTask(input.taskId, {
            title,
            description: input.description?.trim() || null,
            ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
            updated_at: now,
          });
        const updated = await this.getTask(store, input.taskId);
        await this.appendEditChange(store, {
          projectId: input.projectId,
          type: "TASK_EDITED",
          entityId: input.taskId,
          principalId,
          actorRole: "manager",
          before: { title: task.title, description: task.description, sortOrder: task.sort_order },
          after: { title: updated.title, description: updated.description, sortOrder: updated.sort_order },
          occurredAt: now,
        });
        return {
          id: updated.id,
          projectId: updated.project_id,
          storyId: updated.story_id,
          title: updated.title,
          description: updated.description,
          status: updated.status,
          sortOrder: updated.sort_order,
          updatedAt: updated.updated_at,
        };
      }),
    );
  }

  /**
   * DirectionのOutcomeを参照するStoryの参照・snapshotを、transactionの前に解決する。SQLiteの接続はtransaction中は
   * 1本を占有するため、Directionの読取はここ（transactionの外）で行う。認可（manager Grant）を先に検査し、
   * 権限の無い呼び出しにOutcome・Repositoryの存在有無を漏らさない。OutcomeはProjectの所属Workspaceで読み、
   * 別WorkspaceのOutcomeは存在しない扱い、Target ProjectでないProjectからのhandoffは拒否する。再送（同じ`requestId`、
   * または同じ相関IDの既存Story）では参照先が変わっていても元の結果を返すべきなので、解決自体を省く。
   */
  private async resolveStoryReferences(
    principalId: string,
    input: IssueStoryInput,
    requestId: string,
    correlationId: string | null,
  ): Promise<{ outcome: OutcomeReferenceSnapshot | null; constraints: string[]; repository: RepositoryReference | null } | null> {
    const outcomeId = optionalId(input.outcomeId, "outcomeId");
    const repositoryId = optionalId(input.repositoryId, "repositoryId");
    if (outcomeId === null && repositoryId === null) return { outcome: null, constraints: [], repository: null };

    await this.requireRole(this.store, input.projectId, principalId, WorkRole.MANAGER);
    const receipt = await this.store.findReceipt(principalId, "issue_story", requestId);
    if (receipt) return null;
    if (correlationId !== null) {
      const existing = await this.store.findStoryByCorrelation(input.projectId, correlationId);
      if (existing) return null;
    }

    const project = await this.directionReferences.getProjectExecutionContext(input.projectId);
    if (!project) throw new NotFoundError(`Project ${input.projectId} was not found`);
    let outcome: OutcomeReferenceSnapshot | null = null;
    if (outcomeId !== null) {
      outcome = await this.directionReferences.getOutcomeSnapshot(project.workspaceId, outcomeId);
      if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in the Workspace of Project ${input.projectId}`);
      if (outcome.status !== "active") {
        throw new ConflictError(`Outcome ${outcomeId} is ${outcome.status}; Stories can only be created for an active Outcome`, {
          status: outcome.status,
        });
      }
      if (!outcome.targetProjectIds.includes(input.projectId)) {
        throw new ConflictError(`Project ${input.projectId} is not a Target Project of Outcome ${outcomeId}`, {
          reason: "not_target_project",
        });
      }
    }
    let repository: RepositoryReference | null = null;
    if (repositoryId !== null) {
      repository = project.repositories.find((item) => item.id === repositoryId) ?? null;
      if (!repository) throw new NotFoundError(`Repository ${repositoryId} was not found in Project ${input.projectId}`);
    }
    return { outcome, constraints: project.constraints, repository };
  }

  async issueStory(principalId: string, input: IssueStoryInput, requestId: string) {
    const outcomeId = optionalId(input.outcomeId, "outcomeId");
    const explicitCorrelationId = optionalId(input.correlationId, "correlationId");
    if (explicitCorrelationId !== null && explicitCorrelationId.length > maxCorrelationIdLength) {
      throw new CoordinationError("INVALID_INPUT", `correlationId must be ${maxCorrelationIdLength} characters or fewer`);
    }
    // Outcome起点のhandoffは、明示が無ければ決定的な相関IDにする。Runtimeの重複起動・timeout後の再送でも同じStoryへ収束する。
    const correlationId = explicitCorrelationId ?? (outcomeId === null ? null : outcomeCorrelationId(outcomeId));
    const references = await this.resolveStoryReferences(principalId, input, requestId, correlationId);

    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "issue_story", requestId, input, async () => {
        await this.requireRole(store, input.projectId, principalId, WorkRole.MANAGER);
        await this.assertProjectActive(store, input.projectId);
        const title = this.requiredText(input.title, "Story title");
        const description = input.description?.trim() || null;
        const repositoryId = optionalId(input.repositoryId, "repositoryId");

        if (correlationId !== null) {
          const existing = await store.findStoryByCorrelation(input.projectId, correlationId);
          if (existing) {
            const existingRepository = parseSnapshot<RepositoryReference>(existing.repository_snapshot);
            const sameContent =
              existing.title === title &&
              existing.description === description &&
              existing.outcome_ref === outcomeId &&
              (existingRepository?.id ?? null) === repositoryId;
            if (!sameContent) {
              throw new CoordinationError(
                "IDEMPOTENCY_CONFLICT",
                `correlationId ${correlationId} was already used with a different Story`,
              );
            }
            return { ...storyDto(existing), requiredNextTool: "issue_task" as const };
          }
        }
        if ((outcomeId !== null || repositoryId !== null) && references === null) {
          throw new CoordinationError("INVALID_INPUT", "Story references could not be resolved; retry the request");
        }

        const maxSortOrder = await store.maxStorySortOrder(input.projectId);
        const now = this.clock();
        const id = crypto.randomUUID();
        const sortOrder = (maxSortOrder ?? 0) + 1;
        const outcome = references?.outcome ?? null;
        const row = await store.insertStory({
            id,
            project_id: input.projectId,
            title,
            description,
            status: StoryStatus.TODO,
            sort_order: sortOrder,
            created_at: now,
            updated_at: now,
            outcome_ref: outcome?.outcomeId ?? null,
            origin_decision_id: outcome?.originDecisionId ?? null,
            success_criteria_snapshot: outcome ? JSON.stringify(outcome.successCriteria) : null,
            constraints_snapshot: outcome ? JSON.stringify(references?.constraints ?? []) : null,
            repository_snapshot: references?.repository ? JSON.stringify(references.repository) : null,
            correlation_id: correlationId,
          });
        await this.appendChange(store, {
          projectId: input.projectId,
          type: "STORY_CREATED",
          entityId: id,
          principalId,
          payload: {
            actorRole: "manager",
            status: StoryStatus.TODO,
            ...(correlationId === null ? {} : { correlationId }),
            ...(outcome ? { outcomeId: outcome.outcomeId, originDecisionId: outcome.originDecisionId } : {}),
          },
          occurredAt: now,
        });
        return { ...storyDto(row), requiredNextTool: "issue_task" as const };
      }),
    );
  }

  async editStory(
    principalId: string,
    input: {
      projectId: string;
      storyId: string;
      title: string;
      description?: string;
      sortOrder?: number;
    },
    requestId: string,
  ) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "edit_story", requestId, input, async () => {
        await this.requireRole(store, input.projectId, principalId, WorkRole.MANAGER);
        const story = await store.findStoryInProject(input.projectId, input.storyId);
        if (!story) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found in the Project");
        }
        const title = this.requiredText(input.title, "Story title");
        const now = this.clock();
        await store.updateStory(input.storyId, {
            title,
            description: input.description?.trim() || null,
            ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
            updated_at: now,
          });
        await this.appendEditChange(store, {
          projectId: input.projectId,
          type: "STORY_EDITED",
          entityId: input.storyId,
          principalId,
          actorRole: "manager",
          before: { title: story.title, description: story.description, sortOrder: story.sort_order },
          after: { title, description: input.description?.trim() || null, sortOrder: input.sortOrder ?? story.sort_order },
          occurredAt: now,
        });
        return {
          id: input.storyId,
          projectId: input.projectId,
          title,
          description: input.description?.trim() || null,
          status: story.status,
          sortOrder: input.sortOrder ?? story.sort_order,
          updatedAt: now,
        };
      }),
    );
  }

  async completeStory(principalId: string, storyId: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "complete_story", requestId, { storyId }, async () => {
        const story = await store.findStory(storyId);
        if (!story) throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found");
        await this.requireRole(store, story.project_id, principalId, WorkRole.MANAGER);
        if (story.status !== StoryStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} is not doing`);
        }
        if (await store.hasUnsettledTask(storyId)) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} has unsettled Tasks`);
        }
        const now = this.clock();
        await store.updateStory(storyId, { status: StoryStatus.DONE, updated_at: now });
        await this.appendChange(store, {
          projectId: story.project_id,
          type: "STORY_COMPLETED",
          entityId: storyId,
          principalId,
          payload: { actorRole: "manager", fromStatus: StoryStatus.DOING, toStatus: StoryStatus.DONE },
          occurredAt: now,
        });
        return { storyId, status: StoryStatus.DONE };
      }),
    );
  }

  async cancelStory(principalId: string, storyId: string, reason: string, requestId: string) {
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "cancel_story", requestId, { storyId, reason }, async () => {
        const story = await store.findStory(storyId);
        if (!story) throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found");
        await this.requireRole(store, story.project_id, principalId, WorkRole.MANAGER);
        if (story.status !== StoryStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} is not doing`);
        }
        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Cancel reason is required");
        }
        const now = this.clock();
        await store.updateStory(storyId, { status: StoryStatus.CANCELED, updated_at: now });
        await this.appendChange(store, {
          projectId: story.project_id,
          type: "STORY_CANCELED",
          entityId: storyId,
          principalId,
          payload: { actorRole: "manager", fromStatus: StoryStatus.DOING, toStatus: StoryStatus.CANCELED, reason: trimmedReason },
          occurredAt: now,
        });
        return { storyId, status: StoryStatus.CANCELED, reason: trimmedReason };
      }),
    );
  }

  async listChanges(principalId: string, projectId: string, afterCursor = 0, limit = 100) {
    await this.requireAnyRole(this.store, projectId, principalId);
    return this.listChangesOfProject(projectId, afterCursor, limit);
  }

  /** 認可済みの呼出し元（Runtime Credentialの`execution:change:read` scope）だけが使う。Role Grantは検査しない。 */
  async listChangesOfProject(projectId: string, afterCursor = 0, limit = 100) {
    const rows = await this.store.listChangesAfter(projectId, afterCursor, limit);
    const changes = await this.decorateChanges(projectId, rows);
    return {
      changes,
      nextCursor: changes.at(-1)?.cursor ?? afterCursor,
    };
  }

  /**
   * 認可済みの呼出し元（Human向けWeb APIのMembership認可）だけが使う。新しい順に`limit`件を返し、
   * `beforeCursor`を渡すとそれより古い変更を返す。さらに古い変更があれば`nextCursor`に次の`beforeCursor`を返す（無ければ`null`）。
   */
  async listRecentChangesOfProject(projectId: string, beforeCursor: number | null = null, limit = 50) {
    const rows = await this.store.listChangesBefore(projectId, beforeCursor, limit + 1);
    const changes = await this.decorateChanges(projectId, rows.slice(0, limit));
    return { changes, nextCursor: rows.length > limit ? (changes.at(-1)?.cursor ?? null) : null };
  }

  private async decorateChanges(projectId: string, rows: ChangeRecord[]) {
    // Outcomeに相関付いたStory・Taskの変更には、Runtimeが還流の対象を辿れるようoutcomeId・correlationIdを付ける。
    const entityIds = [...new Set(rows.map((row) => row.entity_id))];
    const correlations = new Map<string, { outcomeId: string; correlationId: string }>();
    for (const row of await this.store.listEntityCorrelations(projectId, entityIds)) {
      if (row.outcome_ref !== null) {
        correlations.set(row.id, {
          outcomeId: row.outcome_ref,
          correlationId: row.correlation_id ?? outcomeCorrelationId(row.outcome_ref),
        });
      }
    }
    const changes = rows.map((row) => ({
      cursor: Number(row.cursor),
      projectId: row.project_id,
      type: row.type,
      entityId: row.entity_id,
      principalId: row.principal_id,
      claimId: row.claim_id,
      payload: JSON.parse(row.payload) as Record<string, unknown>,
      occurredAt: row.occurred_at,
      ...correlations.get(row.entity_id),
    }));
    return changes;
  }
}
