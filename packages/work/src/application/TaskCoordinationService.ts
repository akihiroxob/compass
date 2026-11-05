import { assertDeliverablesBelongTo, parseAcceptedDeliverables } from "./taskAcceptanceSchema.ts";
import { consultationRuntimeSchema, waitForConsultationsSchema, taskRequirementVersion, type ConsultationWaitReference } from "./consultationWaitSchema.ts";
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
import type { AcceptedDeliverable, ChangeRecord, StoryRecord, TaskClaimRecord, TaskPullRequestRecord, TaskRecord, WorkStore } from "./port/WorkStore.ts";
import type { PullRequestGateway } from "./port/PullRequestGateway.ts";
import {
  parseGitHubRepositoryUrl,
  repositoryFullName,
  unsatisfiedRequiredChecks,
  type GitHubRepositoryName,
  type PullRequestCheck,
  type PullRequestReviewEvidence,
  type PullRequestSnapshot,
} from "../domain/PullRequest.ts";

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

/** 登録済みPR。`current`はTaskに最後に登録したPR（後続の完了・レビュー・受入の照合対象）。 */
const pullRequestDto = (row: TaskPullRequestRecord, current: boolean) => ({
  id: row.id,
  taskId: row.task_id,
  projectId: row.project_id,
  repositoryId: row.repository_id,
  repository: row.repository,
  number: row.number,
  sequence: row.sequence,
  url: row.url,
  state: row.state,
  draft: row.draft === 1,
  headBranch: row.head_branch,
  headSha: row.head_sha,
  baseBranch: row.base_branch,
  mergeSha: row.merge_sha,
  author: row.author,
  workClaimId: row.work_claim_id,
  principalId: row.principal_id,
  verifiedAt: row.verified_at,
  reviewedHeadSha: row.reviewed_head_sha,
  reviewCommentId: row.review_comment_id,
  reviewCommentUrl: row.review_comment_url,
  acceptedMergeSha: row.accepted_merge_sha,
  acceptanceEvidence: row.acceptance_evidence,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  current,
});

const pullRequestFacts = (snapshot: PullRequestSnapshot) => ({
  url: snapshot.url,
  state: snapshot.state,
  draft: snapshot.draft ? 1 : 0,
  head_branch: snapshot.headBranch,
  head_sha: snapshot.headSha,
  base_branch: snapshot.baseBranch,
  merge_sha: snapshot.mergeSha,
  author: snapshot.author,
});

/** 完了・レビュー・受入でPRを照合する操作（Change・errorの`operation`）。 */
type PullRequestOperation = "complete_task" | "reviewed_task" | "accept_task" | "operator_accept";

/** 照合のためtransactionの外でGitHubから読んだ事実。`rowId`は読んだ時点の現在のPR。 */
type FetchedPullRequest = {
  rowId: string;
  pr: PullRequestSnapshot;
  reviewEvidence: PullRequestReviewEvidence[];
  checks: PullRequestCheck[];
};

export type ReviewedTaskOptions = { expectedHeadSha?: string; reviewCommentId?: number };
/** PRのあるTaskの受入で、Managerが照合したmerge SHAと、ACごとの確認の根拠。 */
export type AcceptanceVerification = { mergeSha: string; evidence: string };

const fullSha = /^[a-f0-9]{40}$/;

const unreviewed = {
  reviewed_head_sha: null, review_comment_id: null, review_comment_url: null, accepted_merge_sha: null, acceptance_evidence: null,
};

const pullRequestRef = (row: TaskPullRequestRecord) => ({ repository: row.repository, number: row.number, url: row.url });

/** 状態遷移のChangeに残す、照合したPRの事実（UIの「対象Commit」等の根拠）。 */
const pullRequestSummary = (row: TaskPullRequestRecord, pr: PullRequestSnapshot) => ({
  repository: row.repository, number: row.number, url: pr.url, state: pr.state, headSha: pr.headSha, baseBranch: pr.baseBranch, mergeSha: pr.mergeSha,
});

/** 照合の失敗ごとの再確認方法。Roleが包括的な文言で止まらず、次の操作を選べるようにする。 */
const recheckGuide = {
  github_retry: "GitHubを読めず、何も記録していない。GitHubの復旧後に同じ入力・同じrequestIdで再送する。最後に確認した事実はlist_task_pull_requestsで読める",
  github_config: "再送では解消しない。PRのRepository・番号とServerのGitHub設定（COMPASS_GITHUB_TOKEN）を確認し、解消しなければreject_task / release_claimで理由を残す",
  retry: "PRの記録が照合中に変わった。list_task_pull_requestsで現在のPRを確認し、新しいrequestIdで再実行する",
  register: "現在のWork Claimでregister_task_pull_requestにopen・非draftのPRを登録（同じPRなら再登録）してからcomplete_taskする",
  merge_failed: "PRがmergeされていない。merge失敗・競合・branch保護の理由をGitHubで確認し、Workerの修正が必要ならreject_taskで差し戻す（修正後のheadを再レビューする）",
  closed: "PRがmergeされずにcloseされた。reject_taskで差し戻し、Workerが新しいPRを登録する",
  new_head: "レビューしたheadと異なるcommitが現在のPRのheadになっている。新しいheadを再レビューし、そのSHAで根拠コメントを残してから再実行する。merge済みならreject_taskで差し戻す",
  review_comment: "現在のReview Claim・レビューしたhead SHA・decision \"approve\"の印を持つPRコメントを投稿し、そのcomment IDをreviewCommentIdに指定する",
  checks: "必須checkの成功を確認できない。GitHubでhead SHAのCI結果を確認し、失敗ならreject_taskで差し戻す。未完了なら完了後に再実行する",
  base_changed: "PRのbase branchが登録時と異なる。WorkerがPRを確認して再登録する必要があるためreject_taskで差し戻す",
  not_reviewed: "PRのあるTaskはReviewerがreviewed_taskでレビュー対象headとmergeを照合してから受け入れる。Reviewerのレビューを待つ",
  acceptance: "list_task_pull_requestsのcurrent PRのmergeShaを対象にACを確認し、verification（mergeSha・evidence）を指定してaccept_taskする",
} as const;

const pullRequestError = (
  code: "PULL_REQUEST_NOT_READY" | "INVALID_INPUT",
  operation: PullRequestOperation,
  taskId: string,
  row: TaskPullRequestRecord,
  message: string,
  recheck: keyof typeof recheckGuide,
  facts: Record<string, unknown> = {},
) =>
  new CoordinationError(code, `${operation}: ${message} (Task ${taskId}, ${row.repository}#${row.number})`, {
    operation, taskId, pullRequest: pullRequestRef(row), ...facts, recheck: recheckGuide[recheck],
  });

const parseReviewedTaskOptions = (options: ReviewedTaskOptions): ReviewedTaskOptions => {
  const { expectedHeadSha, reviewCommentId } = options;
  if (expectedHeadSha !== undefined && !fullSha.test(expectedHeadSha.toLowerCase())) {
    throw new CoordinationError("INVALID_INPUT", "expectedHeadSha must be a full 40-character commit SHA");
  }
  if (reviewCommentId !== undefined && (!Number.isSafeInteger(reviewCommentId) || reviewCommentId < 1)) {
    throw new CoordinationError("INVALID_INPUT", "reviewCommentId must be a positive integer");
  }
  return {
    ...(expectedHeadSha !== undefined ? { expectedHeadSha: expectedHeadSha.toLowerCase() } : {}),
    ...(reviewCommentId !== undefined ? { reviewCommentId } : {}),
  };
};

const maxAcceptanceEvidenceLength = 10_000;

const parseAcceptanceVerification = (input: AcceptanceVerification | undefined): AcceptanceVerification | null => {
  if (input === undefined) return null;
  const mergeSha = typeof input.mergeSha === "string" ? input.mergeSha.trim().toLowerCase() : "";
  const evidence = typeof input.evidence === "string" ? input.evidence.trim() : "";
  if (!fullSha.test(mergeSha)) throw new CoordinationError("INVALID_INPUT", "verification.mergeSha must be a full 40-character commit SHA");
  if (!evidence || evidence.length > maxAcceptanceEvidenceLength) {
    throw new CoordinationError("INVALID_INPUT", `verification.evidence is required (at most ${maxAcceptanceEvidenceLength} characters)`);
  }
  return { mergeSha, evidence };
};

export type RegisterTaskPullRequestInput = { taskId: string; claimId: string; repositoryId: string; number: number };

const parseOwnerName = (fullName: string): GitHubRepositoryName | null => {
  const [owner, name, ...rest] = fullName.split("/");
  return owner && name && rest.length === 0 ? { owner, name } : null;
};

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
    /** GitHubのPR読取。無ければPR登録はGITHUB_UNAVAILABLEで拒否する（一覧は保存済みの記録だけを返す）。 */
    private readonly pullRequests: PullRequestGateway | null = null,
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
    return new TaskCoordinationService(this.store, this.directionReferences, this.clock, this.claimTtlMs, this.pullRequests, activeRole);
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

  /** archivedのProjectでは新しい活動（Story・Task起票、work / review / acceptanceのClaim）を始めない。存在しないProjectは呼び出し前のGrant検査で拒否済み。 */
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
    const [tasks, stories, claims, grantedRoles, completionChanges, archived, consultationWaits] = await Promise.all([
      this.store.listTasks(projectId),
      this.store.listStories(projectId),
      this.store.listActiveClaims(projectId),
      principalId === null ? Promise.resolve([]) : this.grantedRoles(this.store, projectId, principalId),
      this.store.listCompletions(projectId),
      filter?.availableFor ? this.store.projects.isArchived(projectId) : Promise.resolve(false),
      this.store.listConsultationWaits(projectId),
    ]);
    const waits = new Map(consultationWaits.map((wait) => [wait.task_id, wait]));
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
      // archivedのProjectでは新しいClaimを取得できないため、どの工程の候補も返さない。
      if (filter?.availableFor && (archived || waits.has(task.id))) return false;
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
        requirementVersion: taskRequirementVersion(task, stories.find((story) => story.id === task.story_id) ?? null),
        consultationWait: waits.has(task.id) ? {
          state: waits.get(task.id)!.state, phase: waits.get(task.id)!.phase,
          consultations: JSON.parse(waits.get(task.id)!.consultations) as ConsultationWaitReference[],
          failureReason: waits.get(task.id)!.failure_reason,
        } : null,
        activeClaim: unexpiredClaim
          ? {
              claimId: unexpiredClaim.id,
              principalId: unexpiredClaim.principal_id,
              expiresAt: unexpiredClaim.expires_at,
            }
          : null,
        reclaimable: !waits.has(task.id) && task.status === TaskStatus.DOING && claim !== undefined && claim.expires_at <= now,
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
        await this.assertNotConsultationWaiting(store, taskId);
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
        await this.assertProjectActive(store, task.project_id);
        await this.assertNotConsultationWaiting(store, taskId);
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
    await this.assertProjectActive(store, task.project_id);
    await this.assertNotConsultationWaiting(store, taskId);
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
    // PRのあるTaskは、Reviewerがレビュー対象headとmergeを照合するまで受入へ進めない（Reviewer工程を省けない）。
    const pullRequest = task.status === TaskStatus.IN_REVIEW ? await this.currentPullRequest(store, taskId) : null;
    if (pullRequest) {
      throw pullRequestError("PULL_REQUEST_NOT_READY", actorRole === "operator" ? "operator_accept" : "accept_task", taskId, pullRequest,
        "a Task with a pull request cannot skip reviewed_task", "not_reviewed", { status: task.status, headSha: pullRequest.head_sha });
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

  private async assertNotConsultationWaiting(store: WorkStore, taskId: string) {
    if (await store.findConsultationWait(taskId)) {
      throw new CoordinationError("TASK_NOT_CLAIMABLE", `Task ${taskId} is reserved for Consultation resumption`);
    }
  }

  /** 保存済みRuntime情報と待機関係を確定した後、statusを保持してClaimだけを解放する。 */
  async waitForConsultations(principalId: string, raw: unknown, requestId: string) {
    const parsed = waitForConsultationsSchema.safeParse(raw);
    if (!parsed.success) throw new CoordinationError("INVALID_INPUT", parsed.error.message);
    const input = parsed.data;
    return this.store.transaction((store) => this.withReceipt(store, principalId, "wait_for_consultation", requestId, input, async () => {
      const task = await this.getTask(store, input.taskId);
      await this.assertCurrentClaim(store, principalId, task.id, input.claimId);
      await this.assertProjectActive(store, task.project_id);
      const phase = task.status === "doing" ? "work" : task.status === "in_review" ? "review" : task.status === "wait_accept" ? "acceptance" : null;
      if (!phase) throw new CoordinationError("INVALID_TASK_STATUS", "Only an executing Task can wait");
      const role = phase === "work" ? "worker" : phase === "review" ? "reviewer" : "manager";
      await this.requireRole(store, task.project_id, principalId, role);
      const refs: ConsultationWaitReference[] = [];
      for (const id of new Set(input.consultationIds)) {
        const consultation = await store.consultations.find(task.project_id, id);
        if (!consultation || consultation.status === "resolved" || consultation.status === "canceled") {
          throw new CoordinationError("INVALID_INPUT", "An open Consultation in the Task Project is required");
        }
        refs.push({ id, revision: consultation.revision, resolutionId: null });
      }
      const now = this.clock();
      const story = task.story_id ? await store.findStory(task.story_id) : null;
      await store.saveConsultationWait({ task_id: task.id, project_id: task.project_id, principal_id: principalId,
        role, phase, consultations: JSON.stringify(refs), requirement_version: taskRequirementVersion(task, story),
        runtime: JSON.stringify(input.runtime), state: "waiting", failure_reason: null, created_at: now, updated_at: now });
      await store.updateClaim(input.claimId, { state: "released", released_at: now, release_reason: "consultation_wait" });
      await this.appendChange(store, { projectId: task.project_id, type: "TASK_CONSULTATION_WAITING", entityId: task.id,
        principalId, claimId: input.claimId, payload: { actorRole: role, phase, consultationIds: refs.map((ref) => ref.id), reason: input.reason }, occurredAt: now });
      return { taskId: task.id, status: task.status, state: "waiting" as const, phase };
    }));
  }

  /** 現在の相談を全件読む。解決・取消のimmutableな版と要件版を照合し、途中停止後も同じ状態へ収束する。 */
  async reconcileConsultationWaits(principalId: string, projectId: string) {
    return this.store.transaction(async (store) => {
      await this.requireAnyRole(store, projectId, principalId);
      const results = [];
      for (const wait of await store.listConsultationWaits(projectId)) {
        if (wait.principal_id !== principalId || (this.activeRole !== null && wait.role !== this.activeRole)) continue;
        const task = await this.getTask(store, wait.task_id);
        const story = task.story_id ? await store.findStory(task.story_id) : null;
        const refs = JSON.parse(wait.consultations) as ConsultationWaitReference[];
        let reason: string | null = null;
        for (const ref of refs) {
          const current = await store.consultations.find(projectId, ref.id);
          if (!current) { reason = "Consultation not found"; break; }
          if (current.status === "resolved" && current.resolutionId) {
            ref.revision = current.revision; ref.resolutionId = current.resolutionId;
            // 結論が明示した文書反映の依存だけを待機条件に残す。依存の無い結論は反映待ちでも再開できる。
            if (current.prerequisiteTaskIds.length) reason = `Waiting for document Task ${current.prerequisiteTaskIds.join(", ")} required before resumption`;
          } else if (current.status !== "canceled" || !ref.confirmedCancellation || ref.revision !== current.revision) {
            reason = current.status === "canceled" ? "Manager must confirm cancellation and continuation" : `Consultation is ${current.status}`;
          }
        }
        if (taskRequirementVersion(task, story) !== wait.requirement_version) reason = "Requirements changed; Manager must confirm continuation";
        const claim = await store.findActiveClaim(task.id);
        const state = claim && claim.expires_at > this.clock() ? "resuming" : reason ? "waiting" : "ready";
        const updated = { ...wait, consultations: JSON.stringify(refs), state, failure_reason: reason, updated_at: this.clock() } as const;
        await store.saveConsultationWait(updated);
        results.push({ taskId: task.id, phase: wait.phase, state, failureReason: reason,
          runtime: JSON.parse(wait.runtime) as import("zod").infer<typeof consultationRuntimeSchema>,
          requirementVersion: wait.requirement_version, consultations: refs });
      }
      return { resumptions: results };
    });
  }

  /** 取消・要件変更を自動判断せずManagerが現在状態の継続方針を確認する。 */
  async confirmConsultationContinuation(principalId: string, taskId: string, expectedRequirementVersion: string,
    consultationRevisions: { id: string; revision: number }[], reason: string, requestId: string) {
    return this.store.transaction((store) => this.withReceipt(store, principalId, "confirm_consultation_continuation", requestId,
      { taskId, expectedRequirementVersion, consultationRevisions, reason }, async () => {
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, "manager");
        await this.assertProjectActive(store, task.project_id);
        if (!reason.trim()) throw new CoordinationError("INVALID_INPUT", "Continuation reason is required");
        const wait = await store.findConsultationWait(taskId);
        if (!wait) throw new CoordinationError("INVALID_TASK_STATUS", "Task is not waiting");
        const version = taskRequirementVersion(task, task.story_id ? await store.findStory(task.story_id) : null);
        if (version !== expectedRequirementVersion) throw new CoordinationError("IDEMPOTENCY_CONFLICT", "Requirements changed; read current Task again");
        const refs = JSON.parse(wait.consultations) as ConsultationWaitReference[];
        for (const ref of refs) {
          const current = await store.consultations.find(task.project_id, ref.id);
          if (!current || !consultationRevisions.some((value) => value.id === ref.id && value.revision === current.revision)) {
            throw new CoordinationError("IDEMPOTENCY_CONFLICT", "Every current Consultation revision must be confirmed");
          }
          ref.revision = current.revision;
          if (current.status === "canceled") ref.confirmedCancellation = reason.trim();
        }
        await store.saveConsultationWait({ ...wait, requirement_version: version, consultations: JSON.stringify(refs), state: "waiting", failure_reason: null, updated_at: this.clock() });
        return { taskId, requirementVersion: version };
      }));
  }

  /** 同じPrincipal/Roleだけが保存済み成果物を照合して元段階のClaimを再取得できる。 */
  async resumeConsultationTask(principalId: string, taskId: string, rawRuntime: unknown, requestId: string) {
    const parsed = consultationRuntimeSchema.safeParse(rawRuntime);
    if (!parsed.success) throw new CoordinationError("INVALID_INPUT", parsed.error.message);
    // 再開前の再照合とClaim取得はそれぞれ現在状態を読み、取得transactionでも全件を確認する。
    return this.store.transaction((store) => this.withReceipt(store, principalId, "resume_consultation_task", requestId,
      { taskId, runtime: parsed.data }, async () => {
        const task = await this.getTask(store, taskId);
        const wait = await store.findConsultationWait(taskId);
        if (!wait || wait.principal_id !== principalId) throw new CoordinationError("CLAIM_NOT_OWNED", "No saved resumption belongs to this Principal");
        await this.requireRole(store, task.project_id, principalId, wait.role);
        await this.assertProjectActive(store, task.project_id);
        if (taskRequirementVersion(task, task.story_id ? await store.findStory(task.story_id) : null) !== wait.requirement_version) {
          throw new CoordinationError("INVALID_TASK_STATUS", "Requirements changed; Manager confirmation is required");
        }
        if (JSON.stringify(parsed.data) !== JSON.stringify(consultationRuntimeSchema.parse(JSON.parse(wait.runtime)))) {
          throw new CoordinationError("INVALID_INPUT", "Worktree, Context, PR, HEAD or source fingerprint changed; preserve and reassess artifacts");
        }
        const refs = JSON.parse(wait.consultations) as ConsultationWaitReference[];
        for (const ref of refs) {
          const current = await store.consultations.find(task.project_id, ref.id);
          if (!current || (current.status !== "resolved" && !(current.status === "canceled" && ref.confirmedCancellation && ref.revision === current.revision))) {
            throw new CoordinationError("TASK_NOT_CLAIMABLE", "Every Consultation must be resolved or its cancellation confirmed");
          }
          if (current.status === "resolved" && current.prerequisiteTaskIds.length) {
            throw new CoordinationError("TASK_NOT_CLAIMABLE", "The Consultation conclusion requires its document Task to be reflected before resumption");
          }
          if (current.status === "resolved") { ref.revision = current.revision; ref.resolutionId = current.resolutionId; }
        }
        const now = this.clock();
        const currentClaim = await store.findActiveClaim(taskId);
        if (currentClaim && currentClaim.expires_at > now) throw new CoordinationError("CLAIM_CONFLICT", "Resumption already has a live Claim");
        if (currentClaim) await this.expireClaim(store, currentClaim, task.project_id, principalId, wait.role, now);
        const claim = await this.insertClaim(store, taskId, principalId, now);
        await store.saveConsultationWait({ ...wait, consultations: JSON.stringify(refs), state: "resuming", failure_reason: null, updated_at: now });
        await this.appendChange(store, { projectId: task.project_id, type: "TASK_CONSULTATION_RESUMING", entityId: taskId,
          principalId, claimId: claim.id, payload: { actorRole: wait.role, phase: wait.phase }, occurredAt: now });
        return { ...this.claimResult(claim, task.status), projectId: task.project_id, phase: wait.phase, runtime: parsed.data,
          consultations: refs, task: { title: task.title, description: task.description }, requiredNextTool: "get_consultation" };
      }));
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
        await store.deleteConsultationWait(task.id);
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

  /**
   * PRのあるTaskは、現在のWork Claimで登録したopen・非draftのPRをGitHubで確かめてから`in_review`へ進める（GitHubの読取はtransactionの外）。
   * PRの無いTaskは従来どおり。
   */
  async completeTask(principalId: string, taskId: string, claimId: string, requestId: string) {
    const fetched = await this.fetchPullRequestForVerification(principalId, { toolName: "complete_task", requestId }, taskId, "complete_task", WorkRole.WORKER);
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
        const pullRequest = await this.verifyPullRequestForCompletion(store, taskId, claimId, fetched, now);
        await store.updateTask(taskId, {
            status: TaskStatus.IN_REVIEW,
            assignee: null,
            resume_source_status: null,
            updated_at: now,
          });
        await store.deleteConsultationWait(taskId);
        await store.updateClaim(claim.id, { state: "completed", released_at: now, release_reason: "task_completed" });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_COMPLETED",
          entityId: taskId,
          principalId,
          claimId,
          payload: { actorRole: "worker", fromStatus: TaskStatus.DOING, toStatus: TaskStatus.IN_REVIEW, ...(pullRequest ? { pullRequest } : {}) },
          occurredAt: now,
        });
        return { taskId, claimId, status: TaskStatus.IN_REVIEW };
      }),
    );
  }

  /**
   * Taskに登録し、GitHubで確認したPRの履歴（登録順。最後が現在のPR）。ProjectのいずれかのRole Grantで読める。
   * 受入成果物の`pullRequestUrl`やCommentに書いたURLは、GitHubで確認していないため含めない。
   */
  async listTaskPullRequests(principalId: string, taskId: string) {
    const task = await this.getTask(this.store, taskId);
    await this.requireAnyRole(this.store, task.project_id, principalId);
    const rows = await this.store.listTaskPullRequests(taskId);
    return { taskId, pullRequests: rows.map((row, index) => pullRequestDto(row, index === rows.length - 1)) };
  }

  /** 現在のWork Claim・worker Grant・`doing`・Projectに登録したGitHub Repositoryを検査し、対象RepositoryのGitHub名を返す。 */
  private async assertPullRequestRegistrable(store: WorkStore, principalId: string, input: RegisterTaskPullRequestInput) {
    await this.assertCurrentClaim(store, principalId, input.taskId, input.claimId);
    const task = await this.getTask(store, input.taskId);
    await this.requireRole(store, task.project_id, principalId, WorkRole.WORKER);
    await this.assertProjectActive(store, task.project_id);
    if (task.status !== TaskStatus.DOING) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${input.taskId} is not doing`);
    }
    const repository = await store.projects.findRepository(task.project_id, input.repositoryId);
    if (!repository) {
      throw new CoordinationError("INVALID_INPUT", `Repository ${input.repositoryId} is not registered in the Task's Project`);
    }
    const story = task.story_id ? await store.findStory(task.story_id) : null;
    const storyRepository = parseSnapshot<RepositoryReference>(story?.repository_snapshot ?? null);
    if (storyRepository && storyRepository.id !== input.repositoryId) {
      throw new CoordinationError("INVALID_INPUT", `Repository ${input.repositoryId} is not the target Repository of the Task's Story`);
    }
    const github = parseGitHubRepositoryUrl(repository.url);
    if (!github) {
      throw new CoordinationError("INVALID_INPUT", `Repository ${input.repositoryId} is not a GitHub repository (https://github.com/{owner}/{name})`);
    }
    return { task, github };
  }

  /**
   * Work ClaimのもとでGitHubのopen PRをTaskへ登録する。ServerがGitHubからPRを読み、番号・URL・head / base / mergeの事実と確認時刻を保存する。
   * GitHubの読取はSQLiteのtransactionの外で行い、Claim・状態・登録済みPRは保存時に再検査する。
   * 同じ`requestId`の再送はGitHubを読み直さず保存済みの結果を返す（通信断後の照合）。GitHubを読めなかった場合は何も保存しない。
   */
  async registerTaskPullRequest(principalId: string, input: RegisterTaskPullRequestInput, requestId: string) {
    const parsed: RegisterTaskPullRequestInput = {
      taskId: this.requiredText(input.taskId, "taskId"),
      claimId: this.requiredText(input.claimId, "claimId"),
      repositoryId: this.requiredText(input.repositoryId, "repositoryId"),
      number: input.number,
    };
    if (!Number.isSafeInteger(parsed.number) || parsed.number < 1) {
      throw new CoordinationError("INVALID_INPUT", "number must be a positive integer");
    }
    const replay = await this.store.findReceipt(principalId, "register_task_pull_request", requestId);
    const fetched = replay ? null : await this.fetchPullRequestsForRegistration(principalId, parsed);
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "register_task_pull_request", requestId, parsed, async () => {
        if (!fetched) throw new CoordinationError("IDEMPOTENCY_CONFLICT", `requestId ${requestId} changed during registration; retry`);
        const { task, github } = await this.assertPullRequestRegistrable(store, principalId, parsed);
        const repository = repositoryFullName(github);
        const pr = fetched.current;
        if (pr.repository !== repository || pr.number !== parsed.number) {
          throw new CoordinationError("PULL_REQUEST_NOT_READY", `Pull request #${parsed.number} does not belong to ${repository}`);
        }
        if (pr.state !== "open" || pr.draft) {
          throw new CoordinationError("PULL_REQUEST_NOT_READY", `Pull request #${parsed.number} is ${pr.draft ? "a draft" : pr.state}; register an open, ready pull request`);
        }
        const existing = await store.findPullRequestByNumber(repository, parsed.number);
        if (existing && existing.task_id !== parsed.taskId) {
          throw new CoordinationError("PULL_REQUEST_NOT_READY", `Pull request ${repository}#${parsed.number} is registered to another Task`);
        }
        const history = await store.listTaskPullRequests(parsed.taskId);
        const latest = history.at(-1);
        if (existing && latest && latest.id !== existing.id) {
          throw new CoordinationError("PULL_REQUEST_NOT_READY", `Pull request ${repository}#${parsed.number} was superseded by a later pull request`);
        }
        const now = this.clock();
        if (latest && latest.id !== existing?.id && latest.state === "open") {
          const previous = fetched.previous;
          if (!previous || previous.repository !== latest.repository || previous.number !== latest.number) {
            throw new CoordinationError("PULL_REQUEST_NOT_READY", "Task pull request history changed during registration; retry");
          }
          if (previous.state === "open") {
            throw new CoordinationError("PULL_REQUEST_NOT_READY",
              `Pull request ${latest.repository}#${latest.number} is still open; reuse it or close it before registering another`);
          }
          await store.updateTaskPullRequest(latest.id, { ...pullRequestFacts(previous), repository_id: latest.repository_id,
            work_claim_id: latest.work_claim_id, principal_id: latest.principal_id, verified_at: now, updated_at: now });
        }
        // 登録・再登録したPRは未レビュー。以前のレビュー・受入の照合結果を新しいWork Claimへ持ち越さない。
        const facts = { ...pullRequestFacts(pr), repository_id: parsed.repositoryId, work_claim_id: parsed.claimId,
          principal_id: principalId, verified_at: now, updated_at: now, ...unreviewed };
        const id = existing?.id ?? crypto.randomUUID();
        if (existing) await store.updateTaskPullRequest(id, facts);
        else await store.insertTaskPullRequest({ id, task_id: parsed.taskId, project_id: task.project_id, repository, number: parsed.number,
          sequence: (latest?.sequence ?? 0) + 1, created_at: now, ...facts });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_PULL_REQUEST_REGISTERED",
          entityId: parsed.taskId,
          principalId,
          claimId: parsed.claimId,
          payload: { actorRole: "worker", repositoryId: parsed.repositoryId, pullRequest: pr, verifiedAt: now },
          occurredAt: now,
        });
        const rows = await store.listTaskPullRequests(parsed.taskId);
        const saved = rows.find((row) => row.id === id)!;
        return { pullRequest: pullRequestDto(saved, rows.at(-1)?.id === id) };
      }),
    );
  }

  /** 登録前の検査とGitHubの読取（transactionの外）。現在の別のopen PRがあれば、その最新状態も読む。 */
  private async fetchPullRequestsForRegistration(principalId: string, input: RegisterTaskPullRequestInput) {
    const { github } = await this.assertPullRequestRegistrable(this.store, principalId, input);
    if (!this.pullRequests) throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub integration is not configured on this server");
    const current = await this.pullRequests.getPullRequest(github, input.number);
    const latest = (await this.store.listTaskPullRequests(input.taskId)).at(-1);
    const previousRepository: GitHubRepositoryName | null = latest ? parseOwnerName(latest.repository) : null;
    const previous = latest && previousRepository && latest.state === "open" &&
      (latest.repository !== repositoryFullName(github) || latest.number !== input.number)
      ? await this.pullRequests.getPullRequest(previousRepository, latest.number)
      : null;
    return { current, previous };
  }

  /** Taskの現在のPR（登録順の最後）。PRの無いTaskはnullで、GitHubと照合しない従来の経路で進む。 */
  private async currentPullRequest(store: WorkStore, taskId: string) {
    return (await store.listTaskPullRequests(taskId)).at(-1) ?? null;
  }

  /**
   * 完了・レビュー・受入の照合のため、SQLiteのtransactionの外でGitHubを読む。PRの無いTask・同じ`requestId`の再送（受付記録あり）は
   * GitHubを読まずnull。`review`ではレビュー根拠のPRコメントと、Repositoryに必須checkがあるときだけhead SHAのCI結果も読む。
   * GitHubの失敗は、操作・Task・PR・最後に確認した事実・再確認方法を付けて返す（何も記録しない）。
   */
  private async fetchPullRequestForVerification(
    principalId: string,
    request: { toolName: string; requestId: string } | null,
    taskId: string,
    operation: PullRequestOperation,
    role: WorkRole | null,
  ): Promise<FetchedPullRequest | null> {
    if (request && (await this.store.findReceipt(principalId, request.toolName, request.requestId))) return null;
    const task = await this.getTask(this.store, taskId);
    const row = await this.currentPullRequest(this.store, taskId);
    if (!row) return null;
    // GitHubを読む前に、Project Grantの無い呼出しを拒否する（Human operatorは入口が認可済み）。
    if (role) await this.requireRole(this.store, task.project_id, principalId, role);
    const repository = parseOwnerName(row.repository);
    try {
      if (!this.pullRequests || !repository) {
        throw new CoordinationError("GITHUB_UNAVAILABLE", "GitHub integration is not configured on this server");
      }
      const pr = await this.pullRequests.getPullRequest(repository, row.number);
      if (operation !== "reviewed_task") return { rowId: row.id, pr, reviewEvidence: [], checks: [] };
      const required = (await this.store.projects.findRequiredChecks(task.project_id, row.repository_id)) ?? [];
      const [reviewEvidence, checks] = await Promise.all([
        this.pullRequests.listReviewEvidence(repository, row.number),
        required.length ? this.pullRequests.listChecks(repository, pr.headSha) : Promise.resolve([]),
      ]);
      return { rowId: row.id, pr, reviewEvidence, checks };
    } catch (error) {
      if (!(error instanceof CoordinationError)) throw error;
      throw new CoordinationError(
        error.code,
        `${operation}: could not verify ${row.repository}#${row.number} of Task ${taskId} on GitHub (${error.message}); nothing was recorded`,
        {
          operation,
          taskId,
          pullRequest: pullRequestRef(row),
          lastVerified: { state: row.state, headSha: row.head_sha, mergeSha: row.merge_sha, verifiedAt: row.verified_at },
          github: { code: error.code, message: error.message },
          recheck: recheckGuide[error.code === "GITHUB_UNAVAILABLE" ? "github_retry" : "github_config"],
        },
      );
    }
  }

  /** transactionの中で、現在のPRが読んだ時点から変わっていないこと（同じ行・Repository・番号・base branch）を確かめる。PRの無いTaskはnull。 */
  private async verifiedPullRequest(store: WorkStore, taskId: string, fetched: FetchedPullRequest | null, operation: PullRequestOperation) {
    const row = await this.currentPullRequest(store, taskId);
    if (!row) return null;
    if (!fetched || fetched.rowId !== row.id || fetched.pr.repository !== row.repository || fetched.pr.number !== row.number) {
      throw pullRequestError("PULL_REQUEST_NOT_READY", operation, taskId, row, "the Task's current pull request changed during verification", "retry");
    }
    if (fetched.pr.baseBranch !== row.base_branch) {
      throw pullRequestError("PULL_REQUEST_NOT_READY", operation, taskId, row,
        `the base branch changed from ${row.base_branch} to ${fetched.pr.baseBranch}`, "base_changed",
        { registeredBaseBranch: row.base_branch, baseBranch: fetched.pr.baseBranch, state: fetched.pr.state, headSha: fetched.pr.headSha });
    }
    return { row, ...fetched };
  }

  /** 完了: 現在のWork Claimで登録した、open・非draftのPR。確認した事実（現在のhead）を保存し、レビュー・受入の照合結果を消す。 */
  private async verifyPullRequestForCompletion(store: WorkStore, taskId: string, claimId: string, fetched: FetchedPullRequest | null, now: number) {
    const verified = await this.verifiedPullRequest(store, taskId, fetched, "complete_task");
    if (!verified) return null;
    const { row, pr } = verified;
    if (row.work_claim_id !== claimId) {
      throw pullRequestError("PULL_REQUEST_NOT_READY", "complete_task", taskId, row,
        "the current pull request was registered under another Work Claim", "register",
        { workClaimId: claimId, registeredWorkClaimId: row.work_claim_id, state: pr.state, headSha: pr.headSha });
    }
    if (pr.state !== "open" || pr.draft) {
      throw pullRequestError("PULL_REQUEST_NOT_READY", "complete_task", taskId, row,
        `the current pull request is ${pr.draft && pr.state === "open" ? "a draft" : pr.state}`, "register",
        { state: pr.state, draft: pr.draft, headSha: pr.headSha, mergeSha: pr.mergeSha });
    }
    await store.updateTaskPullRequest(row.id, { ...pullRequestFacts(pr), verified_at: now, updated_at: now, ...unreviewed });
    return pullRequestSummary(row, pr);
  }

  /**
   * レビュー: Reviewerがレビューしたhead（`expectedHeadSha`）のままmergeされ、現在のReview Claim・そのhead・承認を示すPRコメント
   * （`reviewCommentId`）があり、Repositoryの必須checkがそのheadで成功していること。必須checkが無ければCIを確認しない。
   */
  private async verifyPullRequestForReview(
    store: WorkStore,
    task: TaskRecord,
    claimId: string,
    options: ReviewedTaskOptions,
    fetched: FetchedPullRequest | null,
    now: number,
  ) {
    const verified = await this.verifiedPullRequest(store, task.id, fetched, "reviewed_task");
    if (!verified) return null;
    const { row, pr, reviewEvidence, checks } = verified;
    const fail = (message: string, recheck: keyof typeof recheckGuide, facts: Record<string, unknown>) =>
      pullRequestError("PULL_REQUEST_NOT_READY", "reviewed_task", task.id, row, message, recheck, facts);
    const { expectedHeadSha, reviewCommentId } = options;
    if (!expectedHeadSha || !reviewCommentId) {
      throw pullRequestError("INVALID_INPUT", "reviewed_task", task.id, row,
        "expectedHeadSha and reviewCommentId are required for a Task with a pull request", "review_comment",
        { state: pr.state, headSha: pr.headSha });
    }
    if (pr.headSha !== expectedHeadSha) {
      throw fail(`the pull request head is ${pr.headSha}, not the reviewed head ${expectedHeadSha}`, "new_head",
        { expectedHeadSha, headSha: pr.headSha, state: pr.state, mergeSha: pr.mergeSha });
    }
    if (pr.state !== "merged") {
      throw fail(`the pull request is ${pr.state}${pr.draft ? " (draft)" : ""} and not merged`, pr.state === "open" ? "merge_failed" : "closed",
        { expectedHeadSha, headSha: pr.headSha, state: pr.state, mergeSha: null });
    }
    const evidence = reviewEvidence.find((item) => item.commentId === reviewCommentId);
    const expected = { taskId: task.id, claimId, headSha: expectedHeadSha, decision: "approve" };
    if (!evidence || evidence.taskId !== expected.taskId || evidence.claimId !== claimId ||
      evidence.headSha !== expectedHeadSha || evidence.decision !== "approve") {
      throw fail(`pull request comment ${reviewCommentId} is not an approval for this Task, Review Claim and head`, "review_comment", {
        reviewCommentId,
        expectedMarker: expected,
        foundMarker: evidence ? { taskId: evidence.taskId, claimId: evidence.claimId, headSha: evidence.headSha, decision: evidence.decision, url: evidence.url } : null,
        headSha: pr.headSha,
        mergeSha: pr.mergeSha,
      });
    }
    const required = await store.projects.findRequiredChecks(task.project_id, row.repository_id);
    if (required === null) {
      throw fail("the pull request's Repository is no longer registered in the Project", "github_config", { repositoryId: row.repository_id });
    }
    const unsatisfied = unsatisfiedRequiredChecks(checks, required);
    if (unsatisfied.length) {
      throw fail(`required checks did not succeed on ${pr.headSha}: ${unsatisfied.map(({ name }) => name).join(", ")}`, "checks",
        { headSha: pr.headSha, mergeSha: pr.mergeSha, requiredChecks: required, unsatisfiedChecks: unsatisfied });
    }
    await store.updateTaskPullRequest(row.id, {
      ...pullRequestFacts(pr), verified_at: now, updated_at: now,
      reviewed_head_sha: pr.headSha, review_comment_id: evidence.commentId, review_comment_url: evidence.url,
    });
    return { ...pullRequestSummary(row, pr), requiredChecks: required, reviewCommentUrl: evidence.url };
  }

  /**
   * 受入: `reviewed_task`で照合したheadのままmergeされていること。Managerは照合したmerge SHAと根拠（`verification`）を指定し、
   * 現在のmerge SHAと一致する場合だけ受け入れる。Human operatorはレビュー済みの現在のmerge SHAを受け入れる。
   */
  private async verifyPullRequestForAcceptance(
    store: WorkStore,
    taskId: string,
    actorRole: ActivityActorRole,
    verification: AcceptanceVerification | null,
    fetched: FetchedPullRequest | null,
    now: number,
  ) {
    const operation: PullRequestOperation = actorRole === "operator" ? "operator_accept" : "accept_task";
    const verified = await this.verifiedPullRequest(store, taskId, fetched, operation);
    if (!verified) {
      if (verification) throw new CoordinationError("INVALID_INPUT", `${operation}: verification applies only to a Task with a pull request (Task ${taskId})`);
      return null;
    }
    const { row, pr } = verified;
    const fail = (message: string, recheck: keyof typeof recheckGuide, facts: Record<string, unknown> = {}) =>
      pullRequestError("PULL_REQUEST_NOT_READY", operation, taskId, row, message, recheck,
        { reviewedHeadSha: row.reviewed_head_sha, headSha: pr.headSha, state: pr.state, mergeSha: pr.mergeSha, ...facts });
    if (!row.reviewed_head_sha) throw fail("the pull request has not been verified by reviewed_task", "not_reviewed");
    if (pr.headSha !== row.reviewed_head_sha) throw fail(`the pull request head ${pr.headSha} is not the reviewed head ${row.reviewed_head_sha}`, "new_head");
    if (pr.state !== "merged" || !pr.mergeSha) throw fail(`the pull request is ${pr.state} and not merged`, "merge_failed");
    if (actorRole !== "operator" && !verification) {
      throw pullRequestError("INVALID_INPUT", operation, taskId, row, "verification (mergeSha and evidence) is required for a Task with a pull request",
        "acceptance", { mergeSha: pr.mergeSha });
    }
    if (verification && verification.mergeSha !== pr.mergeSha) {
      throw fail(`the verified merge SHA ${verification.mergeSha} is not the pull request's merge SHA ${pr.mergeSha}`, "acceptance",
        { expectedMergeSha: verification.mergeSha });
    }
    await store.updateTaskPullRequest(row.id, {
      ...pullRequestFacts(pr), verified_at: now, updated_at: now, accepted_merge_sha: pr.mergeSha, acceptance_evidence: verification?.evidence ?? null,
    });
    return { ...pullRequestSummary(row, pr), reviewedHeadSha: row.reviewed_head_sha };
  }

  /**
   * PRのあるTaskは、Reviewerがレビューしたhead（`expectedHeadSha`）・現在のReview Claimの承認コメント（`reviewCommentId`）・
   * 必須check・mergeをGitHubで照合してから`wait_accept`へ進める。PRの無いTaskは従来どおり。
   */
  async reviewedTask(principalId: string, taskId: string, claimId: string, requestId: string, options: ReviewedTaskOptions = {}) {
    const parsed = parseReviewedTaskOptions(options);
    const fetched = await this.fetchPullRequestForVerification(principalId, { toolName: "reviewed_task", requestId }, taskId, "reviewed_task", WorkRole.REVIEWER);
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "reviewed_task", requestId, { taskId, claimId, ...parsed }, async () => {
        await this.assertCurrentClaim(store, principalId, taskId, claimId);
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.REVIEWER);
        if (task.status !== TaskStatus.IN_REVIEW) {
          throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not in_review`);
        }
        const now = this.clock();
        const pullRequest = await this.verifyPullRequestForReview(store, task, claimId, parsed, fetched, now);
        await store.updateTask(taskId, { status: TaskStatus.WAIT_ACCEPT, updated_at: now });
        await store.deleteConsultationWait(taskId);
        await store.updateClaim(claimId, { state: "completed", released_at: now, release_reason: "task_reviewed" });
        await this.appendChange(store, {
          projectId: task.project_id,
          type: "TASK_REVIEWED",
          entityId: taskId,
          principalId,
          claimId,
          payload: { actorRole: "reviewer", fromStatus: TaskStatus.IN_REVIEW, toStatus: TaskStatus.WAIT_ACCEPT, ...(pullRequest ? { pullRequest } : {}) },
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
    deliverables: AcceptedDeliverable[],
    pullRequestCheck: { fetched: FetchedPullRequest | null; verification: AcceptanceVerification | null },
  ) {
    const task = await this.getTask(store, taskId);
    if (task.status !== TaskStatus.WAIT_ACCEPT) {
      throw new CoordinationError("INVALID_TASK_STATUS", `Task ${taskId} is not wait_accept`);
    }
    const now = this.clock();
    const pullRequest = await this.verifyPullRequestForAcceptance(store, taskId, actorRole, pullRequestCheck.verification, pullRequestCheck.fetched, now);
    await store.updateTask(taskId, {
        status: TaskStatus.ACCEPTED,
        reject_reason: null,
        resume_source_status: null,
        updated_at: now,
      });
    await store.deleteConsultationWait(taskId);
    await store.updateClaim(claimId, { state: "completed", released_at: now, release_reason: "task_accepted" });
    await this.appendChange(store, {
      projectId: task.project_id,
      type: "TASK_ACCEPTED",
      entityId: taskId,
      principalId,
      claimId,
      // 受入成果物は受入証跡としてChangeへ残す（相談の文書反映の参照登録は、これと一致する参照だけを受け付ける）。
      payload: {
        actorRole, fromStatus: TaskStatus.WAIT_ACCEPT, toStatus: TaskStatus.ACCEPTED, ...(deliverables.length ? { deliverables } : {}),
        ...(pullRequest ? { pullRequest, ...(pullRequestCheck.verification ? { verification: pullRequestCheck.verification } : {}) } : {}),
      },
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

  /**
   * `deliverables`は任意の受入成果物（Repository・完全なcommit SHA・変更したpath・PR URL）。RepositoryはTaskのProjectに登録済みで、
   * PR URLはそのRepositoryのpull requestに限る。指定がなければ従来どおり成果物なしで受け入れる。
   */
  async acceptTask(
    principalId: string,
    taskId: string,
    claimId: string,
    requestId: string,
    deliverablesInput?: unknown,
    verificationInput?: AcceptanceVerification,
  ) {
    const deliverables = parseAcceptedDeliverables(deliverablesInput);
    const verification = parseAcceptanceVerification(verificationInput);
    const receiptInput = { taskId, claimId, ...(deliverables.length ? { deliverables } : {}), ...(verification ? { verification } : {}) };
    const fetched = await this.fetchPullRequestForVerification(principalId, { toolName: "accept_task", requestId }, taskId, "accept_task", WorkRole.MANAGER);
    return this.store.transaction(async (store) =>
      this.withReceipt(store, principalId, "accept_task", requestId, receiptInput, async () => {
        await this.assertCurrentClaim(store, principalId, taskId, claimId);
        const task = await this.getTask(store, taskId);
        await this.requireRole(store, task.project_id, principalId, WorkRole.MANAGER);
        await assertDeliverablesBelongTo(deliverables, (repositoryId) => store.projects.findRepository(task.project_id, repositoryId));
        return this.acceptTaskCore(store, principalId, taskId, claimId, "manager", deliverables, { fetched, verification });
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
    await store.deleteConsultationWait(taskId);
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
    await store.deleteConsultationWait(taskId);
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
    // PRのあるTaskは、GitHubを読む前に対象がProjectに属することを確かめる（別ProjectのTask IDは存在しない扱い）。
    await this.getOperatorTask(this.store, projectId, taskId);
    const fetched = await this.fetchPullRequestForVerification(principalId, null, taskId, "operator_accept", null);
    return this.store.transaction(async (store) => {
      await this.getOperatorTask(store, projectId, taskId);
      const claim = await this.claimAcceptanceCore(store, principalId, taskId, "operator");
      return this.acceptTaskCore(store, principalId, taskId, claim.claimId, "operator", [], { fetched, verification: null });
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

  private async getProjectExecutionContext(projectId: string) {
    const project = await this.directionReferences.getProjectExecutionContext(projectId);
    if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
    return project;
  }

  /**
   * Projectの所属WorkspaceでOutcomeを読み、このProjectがTargetであることを検査する。
   * 別WorkspaceのOutcomeは存在しないOutcomeと区別しない。Target外は`CONFLICT`（`not_target_project`）。
   */
  private async getTargetOutcome(projectId: string, workspaceId: string, outcomeId: string) {
    const outcome = await this.directionReferences.getOutcomeSnapshot(workspaceId, outcomeId);
    if (!outcome) throw new NotFoundError(`Outcome ${outcomeId} was not found in the Workspace of Project ${projectId}`);
    if (!outcome.targetProjectIds.includes(projectId)) {
      throw new ConflictError(`Project ${projectId} is not a Target Project of Outcome ${outcomeId}`, {
        reason: "not_target_project",
      });
    }
    return outcome;
  }

  /**
   * ManagerがOutcome handoffの計画に読むContext。Project manager Grantだけで、このProjectをTargetとするOutcomeの本文・
   * 固定Success Criteria・所属WorkspaceのConstraints・ProjectのRepositoryを返す。Workspace Direction Grantは要求も継承もしない。
   * Target外・別WorkspaceのOutcomeは返さない。取消済みOutcomeも状態を確認できるよう返す（Storyは作れない）。
   */
  async getOutcomeHandoffContext(principalId: string, projectId: string, outcomeId: string) {
    await this.requireRole(this.store, projectId, principalId, WorkRole.MANAGER);
    const project = await this.getProjectExecutionContext(projectId);
    const outcome = await this.getTargetOutcome(projectId, project.workspaceId, outcomeId);
    return {
      projectId,
      workspaceId: project.workspaceId,
      correlationId: outcomeCorrelationId(outcome.outcomeId),
      outcome: {
        id: outcome.outcomeId,
        intentId: outcome.intentId,
        title: outcome.title,
        description: outcome.description,
        hypothesis: outcome.hypothesis,
        status: outcome.status,
        originDecisionId: outcome.originDecisionId,
        successCriteria: outcome.successCriteria,
      },
      constraints: project.constraints,
      repositories: project.repositories,
    };
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

    const project = await this.getProjectExecutionContext(input.projectId);
    let outcome: OutcomeReferenceSnapshot | null = null;
    if (outcomeId !== null) {
      outcome = await this.getTargetOutcome(project.projectId, project.workspaceId, outcomeId);
      if (outcome.status !== "active") {
        throw new ConflictError(`Outcome ${outcomeId} is ${outcome.status}; Stories can only be created for an active Outcome`, {
          status: outcome.status,
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

        const outcome = references?.outcome ?? null;
        // snapshotはtransactionの外で読むため、保存と同じtransactionでTargetを再検査する。取得後に解除された古い検査結果では作らない。
        if (outcome !== null && !(await store.outcomeTargets.isTarget(outcome.outcomeId, input.projectId))) {
          throw new ConflictError(`Project ${input.projectId} is not a Target Project of Outcome ${outcome.outcomeId}`, {
            reason: "not_target_project",
          });
        }

        const maxSortOrder = await store.maxStorySortOrder(input.projectId);
        const now = this.clock();
        const id = crypto.randomUUID();
        const sortOrder = (maxSortOrder ?? 0) + 1;
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
