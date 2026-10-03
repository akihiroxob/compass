import { randomUUID } from "node:crypto";
import { ConflictError, inputHash, NotFoundError, ValidationError } from "@compass/shared";
import { ActivityScope, toActivitySummary, type Activity, type ActivitySummary } from "../domain/Activity.ts";
import { parseActivityQuery, parseRecordActivityInput, type ActivityQueryInput } from "./activitySchema.ts";
import type { ActivityAuthorizationPort, ActivityProjectReader } from "./port/ActivityProjectReader.ts";
import type { ActivityStore } from "./port/ActivityStore.ts";

type Clock = () => number;

export type ActivityPage = { activities: ActivitySummary[]; nextCursor: number | null };
export type ActivityDetail = { activity: Activity; corrections: ActivitySummary[] };

const projectNotFound = (projectId: string) => new NotFoundError(`Project ${projectId} was not found`);
const activityNotFound = (activityId: string) => new NotFoundError(`Activity ${activityId} was not found`);

/**
 * Projectの意味的Activityを明示的に記録する（Agentの調査結果・判断理由・決定・引き継ぎ等）。
 * PrincipalはBearerから、RoleはGrantを検査した値（または操作ContextのactiveRole）から決め、入力では上書きさせない。
 * 同じ`requestId`の再送は同じActivityを返し、別の内容での再利用は`CONFLICT`にする。訂正は`correctsActivityId`で追記する。
 */
export class RecordActivityUseCase {
  constructor(
    private readonly authorization: ActivityAuthorizationPort,
    private readonly projects: ActivityProjectReader,
    private readonly store: ActivityStore,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(principal: string | null, input: unknown): Promise<{ activity: Activity; created: boolean }> {
    const parsed = parseRecordActivityInput(input);
    const { requestId, role: requestedRole, ...content } = parsed;
    // 認可はProjectの存在確認より先に行い、Grantを持たないPrincipalへProjectの存在を漏らさない。
    const actor = await this.authorization.resolveActor(principal, content.projectId, requestedRole);
    if (actor === null) {
      throw new ValidationError("Activity input is invalid", [
        { path: "role", message: "role is required when the operation context has no active role" },
      ]);
    }
    const project = await this.projects.find(content.projectId);
    if (!project) throw projectNotFound(content.projectId);
    if (project.archived) {
      throw new ConflictError(`Project ${content.projectId} is archived and can no longer be changed`, { projectStatus: "archived" });
    }
    const unknownResources = content.refs.flatMap((ref, index) =>
      ref.kind === "project_resource" && !project.resourceIds.includes(ref.resourceId)
        ? [{ path: `refs.${index}.resourceId`, message: `Project Resource ${ref.resourceId} is not registered in this Project` }]
        : [],
    );
    if (unknownResources.length) throw new ValidationError("Activity input is invalid", unknownResources);
    if (content.correctsActivityId !== undefined) {
      const corrected = await this.store.find(content.correctsActivityId);
      if (!corrected || corrected.projectId !== content.projectId) {
        throw new NotFoundError(`Activity ${content.correctsActivityId} was not found in this Project`);
      }
    }

    const hash = inputHash({ ...content, role: actor.role });
    const now = this.clock();
    const { activity, created, inputHash: savedHash } = await this.store.append({
      id: this.newId(),
      scope: ActivityScope.PROJECT,
      projectId: content.projectId,
      type: content.type,
      principalId: actor.principalId,
      role: actor.role,
      summary: content.summary,
      body: content.body,
      refs: content.refs,
      correctsActivityId: content.correctsActivityId ?? null,
      source: "recorded",
      occurredAt: content.occurredAt ?? now,
      recordedAt: now,
      dedupeKey: `recorded:${actor.principalId}:${requestId}`,
      inputHash: hash,
    });
    if (!created && savedHash !== hash) {
      throw new ConflictError(`requestId ${requestId} was already used for a different Activity`, { activityId: activity.id });
    }
    return { activity, created };
  }
}

/**
 * ProjectのActivity一覧（summaryとrefsだけ。本文は`GetActivityUseCase`で取得する）。認可は呼び出し側（Agent・Human）の入口で行う。
 * `afterCursor`は昇順の差分取得、それ以外は新しい順で、`nextCursor`を次の`afterCursor` / `beforeCursor`に渡す。
 */
export class ListActivitiesUseCase {
  constructor(
    private readonly projects: ActivityProjectReader,
    private readonly store: ActivityStore,
  ) {}

  async execute(projectId: string, query: ActivityQueryInput = {}): Promise<ActivityPage> {
    const { refKind, refId, ...parsed } = parseActivityQuery(query);
    if (!(await this.projects.find(projectId))) throw projectNotFound(projectId);
    const activities = await this.store.listProject(projectId, {
      ...parsed,
      ...(refKind !== undefined && refId !== undefined ? { ref: { kind: refKind, id: refId } } : {}),
    });
    const ascending = parsed.afterCursor !== undefined;
    const last = activities.at(-1);
    // 差分取得は末尾を次の位置にする（空なら呼び出し側の位置のまま）。新しい順は、満杯のときだけ続きがある。
    const nextCursor = ascending
      ? (last?.cursor ?? parsed.afterCursor ?? null)
      : activities.length === parsed.limit && last
        ? last.cursor
        : null;
    return { activities: activities.map(toActivitySummary), nextCursor };
  }
}

/** Activity 1件の本文・refsと、それを訂正したActivity。別Projectのidは存在しないものとして扱う。 */
export class GetActivityUseCase {
  constructor(
    private readonly projects: ActivityProjectReader,
    private readonly store: ActivityStore,
  ) {}

  async execute(projectId: string, activityId: string): Promise<ActivityDetail> {
    if (!(await this.projects.find(projectId))) throw projectNotFound(projectId);
    const activity = await this.store.find(activityId);
    if (!activity || activity.projectId !== projectId) throw activityNotFound(activityId);
    const corrections = await this.store.listCorrections(activityId);
    return { activity, corrections: corrections.map(toActivitySummary) };
  }
}

/** Agent向けの参照。ProjectのいずれかのGrant（activeRoleの指定時はそのRole）を要求してから委譲する。 */
export class AgentActivityReader {
  constructor(
    private readonly authorization: ActivityAuthorizationPort,
    private readonly list: ListActivitiesUseCase,
    private readonly get: GetActivityUseCase,
  ) {}

  async listActivities(principal: string | null, projectId: string, query: ActivityQueryInput = {}) {
    await this.authorization.requireReader(principal, projectId);
    return this.list.execute(projectId, query);
  }

  async getActivity(principal: string | null, projectId: string, activityId: string) {
    await this.authorization.requireReader(principal, projectId);
    return this.get.execute(projectId, activityId);
  }
}

/** Role Contextへ渡す最近のActivity summary。本文は含めない。 */
export const recentActivitySummaryLimit = 20;
