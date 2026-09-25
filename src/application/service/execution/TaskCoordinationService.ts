import type { Kysely, Selectable, Transaction } from "kysely";

import { ProjectRole } from "../../../constants/ProjectRole.ts";
import { StoryStatus } from "../../../domain/model/execution/StoryStatus.ts";
import { TaskStatus, type TaskStatus as TaskStatusValue } from "../../../domain/model/execution/TaskStatus.ts";
import type { ChangeLogTable, Database, StoryTable, TaskClaimTable, TaskTable } from "../../../infrastructure/database/schema.ts";
import { outcomeCorrelationId } from "../../../shared/outcomeCorrelation.ts";
import { ConflictError } from "../../error/ConflictError.ts";
import { CoordinationError } from "../../error/CoordinationError.ts";
import { NotFoundError } from "../../error/NotFoundError.ts";
import { ProjectArchivedError } from "../../error/ProjectArchivedError.ts";
import type {
  DirectionReferenceLookupPort,
  OutcomeReferenceSnapshot,
  RepositoryReference,
} from "../../port/DirectionReferenceLookupPort.ts";

type DatabaseExecutor = Kysely<Database> | Transaction<Database>;

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
type ActivityActorRole = "worker" | "reviewer" | "manager";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalize(entry)]),
  );
};

const parseSnapshot = <T>(value: string | null): T | null => (value === null ? null : (JSON.parse(value) as T));

const storyDto = (row: Selectable<StoryTable>) => ({
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

const issuedTaskDto = (row: Selectable<TaskTable>) => ({
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
    private readonly database: Kysely<Database>,
    /** Story作成時のOutcome・Repository参照だけに使う読取専用ポート。Direction側のtableは直接読まない。 */
    private readonly directionReferences: DirectionReferenceLookupPort,
    private readonly clock: Clock = () => Date.now(),
    claimTtlMs = Number(process.env.COMPASS_CLAIM_TTL_MS ?? 30 * 60 * 1000),
  ) {
    if (!Number.isFinite(claimTtlMs) || claimTtlMs <= 0) {
      throw new RangeError("COMPASS_CLAIM_TTL_MS must be a positive number");
    }
    this.claimTtlMs = claimTtlMs;
  }

  private requiredText(value: string, field: string): string {
    const trimmed = value.trim();
    if (!trimmed) {
      throw new CoordinationError("INVALID_INPUT", `${field} is required`);
    }
    return trimmed;
  }

  private async requireRole(
    db: DatabaseExecutor,
    projectId: string,
    principalId: string,
    role: "worker" | "reviewer" | "manager",
  ): Promise<void> {
    const grant = await db
      .selectFrom("project_grant")
      .select("role")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .where("role", "=", role)
      .executeTakeFirst();
    if (!grant) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} does not have ${role} role for project ${projectId}`,
      );
    }
  }

  private async requireOneOfRoles(
    db: DatabaseExecutor,
    projectId: string,
    principalId: string,
    roles: Array<"worker" | "reviewer" | "manager">,
  ): Promise<"worker" | "reviewer" | "manager"> {
    const grants = await db
      .selectFrom("project_grant")
      .select("role")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .where("role", "in", roles)
      .execute();
    const role = roles.find((candidate) => grants.some((grant) => grant.role === candidate));
    if (!role) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} does not have one of the required roles (${roles.join(", ")}) for project ${projectId}`,
      );
    }
    return role;
  }

  private async requireAnyRole(
    db: DatabaseExecutor,
    projectId: string,
    principalId: string,
  ): Promise<void> {
    const grant = await db
      .selectFrom("project_grant")
      .select("role")
      .where("project_id", "=", projectId)
      .where("principal_id", "=", principalId)
      .executeTakeFirst();
    if (!grant) {
      throw new CoordinationError(
        "FORBIDDEN",
        `Principal ${principalId} has no role for project ${projectId}`,
      );
    }
  }

  async listStories(principalId: string, projectId: string, status?: string) {
    await this.requireAnyRole(this.database, projectId, principalId);
    return this.listStoriesOfProject(projectId, status);
  }

  /** 共有の根（project）の存在確認。archivedも存在として扱う。 */
  async projectExists(projectId: string): Promise<boolean> {
    return (await this.database.selectFrom("project").select("id").where("id", "=", projectId).executeTakeFirst()) !== undefined;
  }

  /** 認可済みの呼出し元（Human向けWeb APIのMembership認可）だけが使う。Role Grantは検査しない。 */
  async listStoriesOfProject(projectId: string, status?: string) {
    let query = this.database.selectFrom("story").selectAll().where("project_id", "=", projectId);
    if (status) query = query.where("status", "=", status as never);
    const rows = await query.orderBy("sort_order", "asc").orderBy("created_at", "asc").execute();
    return { stories: rows.map(storyDto) };
  }

  async listTaskComments(principalId: string, taskId: string) {
    const task = await this.getTask(this.database, taskId);
    await this.requireAnyRole(this.database, task.project_id, principalId);
    return this.readTaskComments(taskId);
  }

  private async readTaskComments(taskId: string) {
    const rows = await this.database.selectFrom("task_comment")
      .selectAll()
      .where("task_id", "=", taskId)
      .orderBy("created_at", "asc")
      .execute();
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

  private async getTask(db: DatabaseExecutor, taskId: string) {
    const task = await db.selectFrom("task").selectAll().where("id", "=", taskId).executeTakeFirst();
    if (!task) {
      throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} was not found`);
    }
    return task;
  }

  /** archivedのProjectでは新しい活動（Story・Task起票、work Claim）を始めない。存在しないProjectは呼び出し前のGrant検査で拒否済み。 */
  private async assertProjectActive(db: DatabaseExecutor, projectId: string): Promise<void> {
    const project = await db.selectFrom("project").select("status").where("id", "=", projectId).executeTakeFirst();
    if (project?.status === "archived") throw new ProjectArchivedError(projectId);
  }

  private async getActiveClaim(db: DatabaseExecutor, taskId: string) {
    return db
      .selectFrom("task_claim")
      .selectAll()
      .where("task_id", "=", taskId)
      .where("state", "=", "active")
      .executeTakeFirst();
  }

  private async appendChange(
    db: DatabaseExecutor,
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
    const row = await db
      .insertInto("change_log")
      .values({
        project_id: input.projectId,
        type: input.type,
        entity_id: input.entityId,
        principal_id: input.principalId,
        claim_id: input.claimId ?? null,
        payload: JSON.stringify(input.payload),
        occurred_at: input.occurredAt,
      })
      .returning("cursor")
      .executeTakeFirstOrThrow();
    return Number(row.cursor);
  }

  private async expireClaim(
    db: DatabaseExecutor,
    claim: TaskClaimTable,
    projectId: string,
    observedBy: string,
    actorRole: ActivityActorRole,
    now: number,
  ): Promise<void> {
    await db
      .updateTable("task_claim")
      .set({ state: "expired", released_at: now, release_reason: "lease_expired" })
      .where("id", "=", claim.id)
      .where("state", "=", "active")
      .execute();
    await this.appendChange(db, {
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
    db: Transaction<Database>,
    principalId: string,
    toolName: string,
    requestId: string,
    input: ReceiptInput,
    execute: () => Promise<T>,
  ): Promise<T> {
    const inputJson = JSON.stringify(canonicalize(input));
    const existing = await db
      .selectFrom("command_receipt")
      .selectAll()
      .where("principal_id", "=", principalId)
      .where("tool_name", "=", toolName)
      .where("request_id", "=", requestId)
      .executeTakeFirst();
    if (existing) {
      if (existing.input_json !== inputJson) {
        throw new CoordinationError(
          "IDEMPOTENCY_CONFLICT",
          `requestId ${requestId} was already used with different input`,
        );
      }
      return JSON.parse(existing.result_json) as T;
    }

    const result = await execute();
    await db
      .insertInto("command_receipt")
      .values({
        principal_id: principalId,
        tool_name: toolName,
        request_id: requestId,
        input_json: inputJson,
        result_json: JSON.stringify(result),
        created_at: this.clock(),
      })
      .execute();
    return result;
  }

  private claimResult(claim: TaskClaimTable, taskStatus: TaskStatusValue): ClaimResult {
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
    db: DatabaseExecutor,
    taskId: string,
    principalId: string,
    now: number,
  ): Promise<TaskClaimTable> {
    const claim: TaskClaimTable = {
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
    try {
      await db.insertInto("task_claim").values(claim).execute();
    } catch (error) {
      if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
        throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} was claimed concurrently`);
      }
      throw error;
    }
    return claim;
  }

  private async latestCompleter(db: DatabaseExecutor, taskId: string): Promise<string | null> {
    const row = await db
      .selectFrom("change_log")
      .select("principal_id")
      .where("entity_id", "=", taskId)
      .where("type", "=", "TASK_COMPLETED")
      .orderBy("cursor", "desc")
      .executeTakeFirst();
    return row?.principal_id ?? null;
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
    await this.requireAnyRole(this.database, projectId, principalId);
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
    const row = await this.database
      .selectFrom("task")
      .select(["id", "story_id"])
      .where("id", "=", taskId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    if (!row) return null;
    const [list, story, { comments }, changes] = await Promise.all([
      this.buildTaskList(projectId, null),
      row.story_id
        ? this.database.selectFrom("story").selectAll().where("id", "=", row.story_id).executeTakeFirst()
        : Promise.resolve(undefined),
      this.readTaskComments(taskId),
      this.database
        .selectFrom("change_log")
        .selectAll()
        .where("project_id", "=", projectId)
        .where("entity_id", "=", taskId)
        .orderBy("cursor", "asc")
        .execute(),
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
    const [tasks, stories, claims, grants, completionChanges] = await Promise.all([
      this.database.selectFrom("task").selectAll().where("project_id", "=", projectId).execute(),
      this.database.selectFrom("story")
        .select(["id", "sort_order"])
        .where("project_id", "=", projectId)
        .execute(),
      this.database.selectFrom("task_claim")
        .selectAll()
        .where("state", "=", "active")
        .where(
          "task_id",
          "in",
          this.database.selectFrom("task").select("id").where("project_id", "=", projectId),
        )
        .execute(),
      principalId === null
        ? Promise.resolve([])
        : this.database.selectFrom("project_grant")
          .select("role")
          .where("project_id", "=", projectId)
          .where("principal_id", "=", principalId)
          .execute(),
      this.database.selectFrom("change_log")
        .select(["entity_id", "principal_id", "cursor"])
        .where("project_id", "=", projectId)
        .where("type", "=", "TASK_COMPLETED")
        .orderBy("cursor", "desc")
        .execute(),
    ]);
    const storyOrders = new Map(stories.map((story) => [story.id, story.sort_order]));
    const activeClaims = new Map(claims.map((claim) => [claim.task_id, claim]));
    const roles = new Set(grants.map((grant) => grant.role));
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
            roles.has(ProjectRole.WORKER) &&
            (((task.status === TaskStatus.TODO || task.status === TaskStatus.REJECTED) &&
              !hasUnexpiredClaim) ||
              (task.status === TaskStatus.DOING && claim !== undefined && claim.expires_at <= now))
          );
        case "review":
          return (
            roles.has(ProjectRole.REVIEWER) &&
            task.status === TaskStatus.IN_REVIEW &&
            !hasUnexpiredClaim &&
            latestCompleters.get(task.id) !== principalId
          );
        case "acceptance":
          return (
            roles.has(ProjectRole.MANAGER) &&
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "claim_task", requestId, { taskId }, async () => {
        const now = this.clock();
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.WORKER);
        await this.assertProjectActive(db, task.project_id);
        const currentClaim = await this.getActiveClaim(db, taskId);
        let reclaimingExpiredWork = false;
        if (currentClaim) {
          if (currentClaim.expires_at > now) {
            throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
          }
          reclaimingExpiredWork = task.status === TaskStatus.DOING;
          await this.expireClaim(db, currentClaim, task.project_id, principalId, "worker", now);
        }
        if (
          task.status !== TaskStatus.TODO &&
          task.status !== TaskStatus.REJECTED &&
          !(task.status === TaskStatus.DOING && reclaimingExpiredWork)
        ) {
          throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} is not available for work`);
        }
        const fromStatus = task.status;
        const claim = await this.insertClaim(db, taskId, principalId, now);
        await db
          .updateTable("task")
          .set({
            status: TaskStatus.DOING,
            assignee: null,
            resume_source_status:
              fromStatus === TaskStatus.REJECTED ? TaskStatus.REJECTED : TaskStatus.TODO,
            updated_at: now,
          })
          .where("id", "=", taskId)
          .execute();
        if (task.story_id) {
          const story = await db
            .selectFrom("story")
            .select("status")
            .where("id", "=", task.story_id)
            .executeTakeFirst();
          if (story?.status === StoryStatus.TODO) {
            await db
              .updateTable("story")
              .set({ status: StoryStatus.DOING, updated_at: now })
              .where("id", "=", task.story_id)
              .execute();
            await this.appendChange(db, {
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
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "claim_review", requestId, { taskId }, async () => {
        const now = this.clock();
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.REVIEWER);
        const currentClaim = await this.getActiveClaim(db, taskId);
        if (currentClaim) {
          if (currentClaim.expires_at > now) {
            throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
          }
          await this.expireClaim(db, currentClaim, task.project_id, principalId, "reviewer", now);
        }
        if (task.status !== TaskStatus.IN_REVIEW) {
          throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} is not available for review`);
        }
        if ((await this.latestCompleter(db, taskId)) === principalId) {
          throw new CoordinationError(
            "SELF_REVIEW_NOT_ALLOWED",
            `Principal ${principalId} cannot review its own completed work`,
          );
        }
        const claim = await this.insertClaim(db, taskId, principalId, now);
        await this.appendChange(db, {
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

  async claimAcceptance(
    principalId: string,
    taskId: string,
    requestId: string,
  ): Promise<ClaimResult> {
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "claim_acceptance", requestId, { taskId }, async () => {
        const now = this.clock();
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.MANAGER);
        const currentClaim = await this.getActiveClaim(db, taskId);
        if (currentClaim) {
          if (currentClaim.expires_at > now) {
            throw new CoordinationError("CLAIM_CONFLICT", `Task ${taskId} already has an active Claim`);
          }
          await this.expireClaim(db, currentClaim, task.project_id, principalId, "manager", now);
        }
        if (task.status !== TaskStatus.IN_REVIEW && task.status !== TaskStatus.WAIT_ACCEPT) {
          throw new CoordinationError(
            "TASK_NOT_CLAIMABLE",
            `Task ${taskId} is not available for acceptance`,
          );
        }
        if ((await this.latestCompleter(db, taskId)) === principalId) {
          throw new CoordinationError(
            "SELF_ACCEPTANCE_NOT_ALLOWED",
            `Principal ${principalId} cannot accept its own completed work`,
          );
        }
        const fromStatus = task.status;
        const claim = await this.insertClaim(db, taskId, principalId, now);
        if (fromStatus === TaskStatus.IN_REVIEW) {
          await db
            .updateTable("task")
            .set({ status: TaskStatus.WAIT_ACCEPT, updated_at: now })
            .where("id", "=", taskId)
            .execute();
        }
        await this.appendChange(db, {
          projectId: task.project_id,
          type: "TASK_CLAIMED",
          entityId: taskId,
          principalId,
          claimId: claim.id,
          payload: {
            actorRole: "manager",
            claimCommand: "claim_acceptance",
            fromStatus,
            toStatus: TaskStatus.WAIT_ACCEPT,
            path: fromStatus === TaskStatus.IN_REVIEW ? "manager_direct_review" : "reviewer_approved",
          },
          occurredAt: now,
        });
        return this.claimResult(claim, TaskStatus.WAIT_ACCEPT);
      }),
    );
  }

  private async assertCurrentClaim(
    db: DatabaseExecutor,
    principalId: string,
    taskId: string,
    claimId: string,
  ) {
    const claim = await db
      .selectFrom("task_claim")
      .selectAll()
      .where("id", "=", claimId)
      .executeTakeFirst();
    if (!claim || claim.task_id !== taskId) {
      throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found for Task ${taskId}`);
    }
    if (claim.principal_id !== principalId) {
      throw new CoordinationError("CLAIM_NOT_OWNED", `Claim ${claimId} belongs to another Principal`);
    }
    if (claim.state !== "active" || claim.expires_at <= this.clock()) {
      throw new CoordinationError("CLAIM_EXPIRED", `Claim ${claimId} is no longer active`);
    }
    const current = await this.getActiveClaim(db, taskId);
    if (!current || current.id !== claimId) {
      throw new CoordinationError("CLAIM_EXPIRED", `Claim ${claimId} is not the current Task Claim`);
    }
    return claim;
  }

  async renewClaim(principalId: string, claimId: string) {
    return this.database.transaction().execute(async (db) => {
      const claim = await db.selectFrom("task_claim").selectAll().where("id", "=", claimId).executeTakeFirst();
      if (!claim) throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found`);
      await this.assertCurrentClaim(db, principalId, claim.task_id, claimId);
      const now = this.clock();
      const expiresAt = now + this.claimTtlMs;
      await db
        .updateTable("task_claim")
        .set({ renewed_at: now, expires_at: expiresAt })
        .where("id", "=", claimId)
        .execute();
      return { claimId, taskId: claim.task_id, renewedAt: now, expiresAt };
    });
  }

  async releaseClaim(
    principalId: string,
    claimId: string,
    reason: string,
    requestId: string,
  ) {
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "release_claim", requestId, { claimId, reason }, async () => {
        const claim = await db.selectFrom("task_claim").selectAll().where("id", "=", claimId).executeTakeFirst();
        if (!claim) throw new CoordinationError("CLAIM_NOT_FOUND", `Claim ${claimId} was not found`);
        await this.assertCurrentClaim(db, principalId, claim.task_id, claimId);
        const task = await this.getTask(db, claim.task_id);
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
          await db
            .updateTable("task")
            .set({
              status: TaskStatus.TODO,
              assignee: null,
              resume_source_status: null,
              updated_at: now,
            })
            .where("id", "=", task.id)
            .execute();
        }
        await db
          .updateTable("task_claim")
          .set({ state: "released", released_at: now, release_reason: trimmedReason })
          .where("id", "=", claimId)
          .execute();
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(
        db,
        principalId,
        "add_task_comment",
        requestId,
        { taskId, claimId, body },
        async () => {
          await this.assertCurrentClaim(db, principalId, taskId, claimId);
          const task = await this.getTask(db, taskId);
          if (task.status === TaskStatus.DOING) {
            await this.requireRole(db, task.project_id, principalId, ProjectRole.WORKER);
          } else if (task.status === TaskStatus.IN_REVIEW) {
            await this.requireRole(db, task.project_id, principalId, ProjectRole.REVIEWER);
          } else if (task.status === TaskStatus.WAIT_ACCEPT) {
            await this.requireRole(db, task.project_id, principalId, ProjectRole.MANAGER);
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
          await db
            .insertInto("task_comment")
            .values({
              id,
              task_id: taskId,
              body: trimmedBody,
              author: principalId,
              principal_id: principalId,
              claim_id: claimId,
              created_at: now,
            })
            .execute();
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "complete_task", requestId, { taskId, claimId }, async () => {
        const claim = await this.assertCurrentClaim(db, principalId, taskId, claimId);
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.WORKER);
        if (task.status !== TaskStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not doing`);
        }
        const comment = await db
          .selectFrom("task_comment")
          .select("id")
          .where("task_id", "=", taskId)
          .where("claim_id", "=", claimId)
          .where("principal_id", "=", principalId)
          .executeTakeFirst();
        if (!comment) {
          throw new CoordinationError(
            "INVALID_TASK_STATUS",
            "Record implementation and verification notes with add_task_comment before complete_task",
          );
        }
        const now = this.clock();
        await db
          .updateTable("task")
          .set({
            status: TaskStatus.IN_REVIEW,
            assignee: null,
            resume_source_status: null,
            updated_at: now,
          })
          .where("id", "=", taskId)
          .execute();
        await db
          .updateTable("task_claim")
          .set({ state: "completed", released_at: now, release_reason: "task_completed" })
          .where("id", "=", claim.id)
          .execute();
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "reviewed_task", requestId, { taskId, claimId }, async () => {
        await this.assertCurrentClaim(db, principalId, taskId, claimId);
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.REVIEWER);
        if (task.status !== TaskStatus.IN_REVIEW) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not in_review`);
        }
        const now = this.clock();
        await db
          .updateTable("task")
          .set({ status: TaskStatus.WAIT_ACCEPT, updated_at: now })
          .where("id", "=", taskId)
          .execute();
        await db
          .updateTable("task_claim")
          .set({ state: "completed", released_at: now, release_reason: "task_reviewed" })
          .where("id", "=", claimId)
          .execute();
        await this.appendChange(db, {
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
    db: DatabaseExecutor,
    projectId: string,
    storyId: string | null,
    principalId: string,
    claimId: string,
    actorRole: ActivityActorRole,
    now: number,
  ) {
    if (!storyId) return;
    const unsettled = await db
      .selectFrom("task")
      .select("id")
      .where("story_id", "=", storyId)
      .where("status", "not in", [TaskStatus.ACCEPTED, TaskStatus.CANCELED])
      .executeTakeFirst();
    if (!unsettled) {
      const result = await db
        .updateTable("story")
        .set({ status: "done", updated_at: now })
        .where("id", "=", storyId)
        .where("status", "=", "doing")
        .executeTakeFirst();
      if (result.numUpdatedRows > 0n) {
        await this.appendChange(db, {
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
    db: DatabaseExecutor,
    principalId: string,
    taskId: string,
    claimId: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(db, taskId);
    if (task.status !== TaskStatus.WAIT_ACCEPT) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not wait_accept`);
    }
    const now = this.clock();
    await db
      .updateTable("task")
      .set({
        status: TaskStatus.ACCEPTED,
        reject_reason: null,
        resume_source_status: null,
        updated_at: now,
      })
      .where("id", "=", taskId)
      .execute();
    await db
      .updateTable("task_claim")
      .set({ state: "completed", released_at: now, release_reason: "task_accepted" })
      .where("id", "=", claimId)
      .execute();
    await this.appendChange(db, {
      projectId: task.project_id,
      type: "TASK_ACCEPTED",
      entityId: taskId,
      principalId,
      claimId,
      payload: { actorRole, fromStatus: TaskStatus.WAIT_ACCEPT, toStatus: TaskStatus.ACCEPTED },
      occurredAt: now,
    });
    await this.syncStoryAfterAcceptance(
      db,
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "accept_task", requestId, { taskId, claimId }, async () => {
        await this.assertCurrentClaim(db, principalId, taskId, claimId);
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.MANAGER);
        return this.acceptTaskCore(db, principalId, taskId, claimId, "manager");
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(
        db,
        principalId,
        "reject_task",
        requestId,
        { taskId, claimId, reason },
        async () => {
          await this.assertCurrentClaim(db, principalId, taskId, claimId);
          const task = await this.getTask(db, taskId);
          let actorRole: ActivityActorRole;
          if (task.status === TaskStatus.IN_REVIEW) {
            await this.requireRole(db, task.project_id, principalId, ProjectRole.REVIEWER);
            actorRole = "reviewer";
          } else if (task.status === TaskStatus.WAIT_ACCEPT) {
            await this.requireRole(db, task.project_id, principalId, ProjectRole.MANAGER);
            actorRole = "manager";
          } else {
            throw new CoordinationError(
              "INVALID_TASK_STATUS",
              `Task ${taskId} is not reviewable`,
            );
          }
          return this.rejectTaskCore(db, principalId, taskId, claimId, reason, actorRole);
        },
      ),
    );
  }

  private async rejectTaskCore(
    db: DatabaseExecutor,
    principalId: string,
    taskId: string,
    claimId: string,
    reason: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(db, taskId);
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new CoordinationError("INVALID_INPUT", "Reject reason is required");
    }
    const now = this.clock();
    const fromStatus = task.status;
    await db
      .updateTable("task")
      .set({
        status: TaskStatus.REJECTED,
        reject_reason: trimmedReason,
        resume_source_status: null,
        updated_at: now,
      })
      .where("id", "=", taskId)
      .execute();
    await db
      .updateTable("task_claim")
      .set({ state: "completed", released_at: now, release_reason: "task_rejected" })
      .where("id", "=", claimId)
      .execute();
    await this.appendChange(db, {
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
    db: DatabaseExecutor,
    principalId: string,
    taskId: string,
    reason: string,
    actorRole: ActivityActorRole,
  ) {
    const task = await this.getTask(db, taskId);
    if (task.status !== TaskStatus.TODO && task.status !== TaskStatus.DOING) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not cancelable`);
    }
    const trimmedReason = reason.trim();
    if (!trimmedReason) {
      throw new CoordinationError("INVALID_INPUT", "Cancel reason is required");
    }
    const now = this.clock();
    const claim = await this.getActiveClaim(db, taskId);
    if (claim) {
      await db
        .updateTable("task_claim")
        .set({ state: "released", released_at: now, release_reason: "task_canceled" })
        .where("id", "=", claim.id)
        .execute();
    }
    await db
      .updateTable("task")
      .set({
        status: TaskStatus.CANCELED,
        assignee: null,
        resume_source_status: null,
        updated_at: now,
      })
      .where("id", "=", taskId)
      .execute();
    await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "cancel_task", requestId, { taskId, reason }, async () => {
        const task = await this.getTask(db, taskId);
        await this.requireRole(db, task.project_id, principalId, ProjectRole.MANAGER);
        return this.cancelTaskCore(db, principalId, taskId, reason, "manager");
      }),
    );
  }

  async issueTask(principalId: string, input: IssueTaskInput, requestId: string) {
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "issue_task", requestId, input, async () => {
        const actorRole = await this.requireOneOfRoles(db, input.projectId, principalId, [
          ProjectRole.MANAGER,
          ProjectRole.REVIEWER,
          ProjectRole.WORKER,
        ]);
        await this.assertProjectActive(db, input.projectId);
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
          story = await db
            .selectFrom("story")
            .select(["correlation_id", "outcome_ref"])
            .where("id", "=", input.storyId)
            .where("project_id", "=", input.projectId)
            .executeTakeFirst();
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
          const existing = await db
            .selectFrom("task")
            .selectAll()
            .where("story_id", "=", input.storyId ?? null)
            .where("task_key", "=", taskKey)
            .executeTakeFirst();
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
        const maxRow = await db
          .selectFrom("task")
          .select(({ fn }) => fn.max("sort_order").as("max_sort_order"))
          .where("project_id", "=", input.projectId)
          .executeTakeFirst();
        const id = crypto.randomUUID();
        const sortOrder = (maxRow?.max_sort_order ?? 0) + 1;
        const row = await db
          .insertInto("task")
          .values({
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
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "edit_task", requestId, input, async () => {
        await this.requireRole(db, input.projectId, principalId, ProjectRole.MANAGER);
        const task = await this.getTask(db, input.taskId);
        if (task.project_id !== input.projectId) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Task does not belong to the Project");
        }
        const title = this.requiredText(input.title, "Task title");
        const now = this.clock();
        await db
          .updateTable("task")
          .set({
            title,
            description: input.description?.trim() || null,
            ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
            updated_at: now,
          })
          .where("id", "=", input.taskId)
          .execute();
        const updated = await this.getTask(db, input.taskId);
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
   * 権限の無い呼び出しにOutcome・Repositoryの存在有無を漏らさない。再送（同じ`requestId`、または同じ相関IDの既存Story）では
   * 参照先が変わっていても元の結果を返すべきなので、解決自体を省く。
   */
  private async resolveStoryReferences(
    principalId: string,
    input: IssueStoryInput,
    requestId: string,
    correlationId: string | null,
  ): Promise<{ outcome: OutcomeReferenceSnapshot | null; repository: RepositoryReference | null } | null> {
    const outcomeId = optionalId(input.outcomeId, "outcomeId");
    const repositoryId = optionalId(input.repositoryId, "repositoryId");
    if (outcomeId === null && repositoryId === null) return { outcome: null, repository: null };

    await this.requireRole(this.database, input.projectId, principalId, ProjectRole.MANAGER);
    const receipt = await this.database
      .selectFrom("command_receipt")
      .select("request_id")
      .where("principal_id", "=", principalId)
      .where("tool_name", "=", "issue_story")
      .where("request_id", "=", requestId)
      .executeTakeFirst();
    if (receipt) return null;
    if (correlationId !== null) {
      const existing = await this.database
        .selectFrom("story")
        .select("id")
        .where("project_id", "=", input.projectId)
        .where("correlation_id", "=", correlationId)
        .executeTakeFirst();
      if (existing) return null;
    }

    let outcome: OutcomeReferenceSnapshot | null = null;
    if (outcomeId !== null) {
      outcome = await this.directionReferences.getOutcomeSnapshot(input.projectId, outcomeId);
      if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in Project ${input.projectId}`);
      if (outcome.status !== "active") {
        throw new ConflictError(`Outcome ${outcomeId} is ${outcome.status}; Stories can only be created for an active Outcome`, {
          status: outcome.status,
        });
      }
    }
    let repository: RepositoryReference | null = null;
    if (repositoryId !== null) {
      repository = await this.directionReferences.getRepositoryReference(input.projectId, repositoryId);
      if (!repository) throw new NotFoundError(`Repository ${repositoryId} was not found in Project ${input.projectId}`);
    }
    return { outcome, repository };
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

    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "issue_story", requestId, input, async () => {
        await this.requireRole(db, input.projectId, principalId, ProjectRole.MANAGER);
        await this.assertProjectActive(db, input.projectId);
        const title = this.requiredText(input.title, "Story title");
        const description = input.description?.trim() || null;
        const repositoryId = optionalId(input.repositoryId, "repositoryId");

        if (correlationId !== null) {
          const existing = await db
            .selectFrom("story")
            .selectAll()
            .where("project_id", "=", input.projectId)
            .where("correlation_id", "=", correlationId)
            .executeTakeFirst();
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

        const maxRow = await db
          .selectFrom("story")
          .select(({ fn }) => fn.max("sort_order").as("max_sort_order"))
          .where("project_id", "=", input.projectId)
          .executeTakeFirst();
        const now = this.clock();
        const id = crypto.randomUUID();
        const sortOrder = (maxRow?.max_sort_order ?? 0) + 1;
        const outcome = references?.outcome ?? null;
        const row = await db
          .insertInto("story")
          .values({
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
            constraints_snapshot: outcome ? JSON.stringify(outcome.constraints) : null,
            repository_snapshot: references?.repository ? JSON.stringify(references.repository) : null,
            correlation_id: correlationId,
          })
          .returningAll()
          .executeTakeFirstOrThrow();
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "edit_story", requestId, input, async () => {
        await this.requireRole(db, input.projectId, principalId, ProjectRole.MANAGER);
        const story = await db
          .selectFrom("story")
          .selectAll()
          .where("id", "=", input.storyId)
          .where("project_id", "=", input.projectId)
          .executeTakeFirst();
        if (!story) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found in the Project");
        }
        const title = this.requiredText(input.title, "Story title");
        const now = this.clock();
        await db
          .updateTable("story")
          .set({
            title,
            description: input.description?.trim() || null,
            ...(input.sortOrder === undefined ? {} : { sort_order: input.sortOrder }),
            updated_at: now,
          })
          .where("id", "=", input.storyId)
          .execute();
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "complete_story", requestId, { storyId }, async () => {
        const story = await db.selectFrom("story").selectAll().where("id", "=", storyId).executeTakeFirst();
        if (!story) throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found");
        await this.requireRole(db, story.project_id, principalId, ProjectRole.MANAGER);
        if (story.status !== StoryStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} is not doing`);
        }
        const unsettled = await db
          .selectFrom("task")
          .select("id")
          .where("story_id", "=", storyId)
          .where("status", "not in", [TaskStatus.ACCEPTED, TaskStatus.CANCELED])
          .executeTakeFirst();
        if (unsettled) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} has unsettled Tasks`);
        }
        const now = this.clock();
        await db
          .updateTable("story")
          .set({ status: StoryStatus.DONE, updated_at: now })
          .where("id", "=", storyId)
          .execute();
        await this.appendChange(db, {
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
    return this.database.transaction().execute(async (db) =>
      this.withReceipt(db, principalId, "cancel_story", requestId, { storyId, reason }, async () => {
        const story = await db.selectFrom("story").selectAll().where("id", "=", storyId).executeTakeFirst();
        if (!story) throw new CoordinationError("INVALID_TASK_STATUS", "Story was not found");
        await this.requireRole(db, story.project_id, principalId, ProjectRole.MANAGER);
        if (story.status !== StoryStatus.DOING) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Story ${storyId} is not doing`);
        }
        const trimmedReason = reason.trim();
        if (!trimmedReason) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Cancel reason is required");
        }
        const now = this.clock();
        await db
          .updateTable("story")
          .set({ status: StoryStatus.CANCELED, updated_at: now })
          .where("id", "=", storyId)
          .execute();
        await this.appendChange(db, {
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
    await this.requireAnyRole(this.database, projectId, principalId);
    return this.listChangesOfProject(projectId, afterCursor, limit);
  }

  /** 認可済みの呼出し元（Runtime Credentialの`execution:change:read` scope）だけが使う。Role Grantは検査しない。 */
  async listChangesOfProject(projectId: string, afterCursor = 0, limit = 100) {
    const rows = await this.database.selectFrom("change_log")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("cursor", ">", afterCursor)
      .orderBy("cursor", "asc")
      .limit(limit)
      .execute();
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
    let query = this.database.selectFrom("change_log").selectAll().where("project_id", "=", projectId);
    if (beforeCursor !== null) query = query.where("cursor", "<", beforeCursor);
    const rows = await query.orderBy("cursor", "desc").limit(limit + 1).execute();
    const changes = await this.decorateChanges(projectId, rows.slice(0, limit));
    return { changes, nextCursor: rows.length > limit ? (changes.at(-1)?.cursor ?? null) : null };
  }

  private async decorateChanges(projectId: string, rows: Selectable<ChangeLogTable>[]) {
    // Outcomeに相関付いたStory・Taskの変更には、Runtimeが還流の対象を辿れるようoutcomeId・correlationIdを付ける。
    const entityIds = [...new Set(rows.map((row) => row.entity_id))];
    const correlations = new Map<string, { outcomeId: string; correlationId: string }>();
    if (entityIds.length > 0) {
      const stories = await this.database
        .selectFrom("story")
        .select(["id", "outcome_ref", "correlation_id"])
        .where("project_id", "=", projectId)
        .where("id", "in", entityIds)
        .execute();
      const tasks = await this.database
        .selectFrom("task")
        .innerJoin("story", "story.id", "task.story_id")
        .select(["task.id as id", "story.outcome_ref as outcome_ref", "story.correlation_id as correlation_id"])
        .where("task.project_id", "=", projectId)
        .where("task.id", "in", entityIds)
        .execute();
      for (const row of [...stories, ...tasks]) {
        if (row.outcome_ref !== null) {
          correlations.set(row.id, {
            outcomeId: row.outcome_ref,
            correlationId: row.correlation_id ?? outcomeCorrelationId(row.outcome_ref),
          });
        }
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
