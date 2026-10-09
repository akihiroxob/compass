import { randomUUID } from "node:crypto";
import { ConflictError, inputHash, NotFoundError, ValidationError } from "@compass/shared";
import {
  ActivityScope,
  toActivitySummary,
  type Activity,
  type ActivitySummary,
  type ActivityTarget,
  type ActivityTargetKind,
} from "../domain/Activity.ts";
import { parseActivityQuery, parseRecordActivityInput, type ActivityQueryInput } from "./activitySchema.ts";
import type { ActivityAuthorizationPort, ActivityScopeReader, ActivityScopeState } from "./port/ActivityScopeReader.ts";
import type { ActivityStore, ActivityUnitOfWork } from "./port/ActivityStore.ts";

type Clock = () => number;

export type ActivityPage = { activities: ActivitySummary[]; nextCursor: number | null };
export type ActivityDetail = { activity: Activity; corrections: ActivitySummary[] };

const scopeLabels: Record<ActivityTargetKind, string> = { project: "Project", workspace: "Workspace" };
const targetNotFound = ({ kind, id }: ActivityTarget) => new NotFoundError(`${scopeLabels[kind]} ${id} was not found`);
const activityNotFound = (activityId: string) => new NotFoundError(`Activity ${activityId} was not found`);

/** Activityが対象scope（同じscope・Workspace・Project）に属するか。別scopeのidは存在しないものとして扱う。 */
const belongsTo = (activity: Activity, target: ActivityTarget, state: ActivityScopeState): boolean =>
  activity.scope === target.kind && activity.workspaceId === state.workspaceId && activity.projectId === state.projectId;

/**
 * Project・Workspaceの意味的Activityを明示的に記録する（Agentの調査結果・判断理由・決定・引き継ぎ等）。scopeはinstanceごとに固定し、
 * 入力の`projectId`（Project）・`workspaceId`（Workspace）で対象を指定する。
 * PrincipalはBearerから、RoleはGrantを検査した値（または操作ContextのactiveRole）から決め、入力では上書きさせない。
 * 同じ`requestId`の再送は同じActivityを返し、別の内容での再利用は`CONFLICT`にする。訂正は`correctsActivityId`で追記する。
 */
export class RecordActivityUseCase {
  constructor(
    private readonly kind: ActivityTargetKind,
    private readonly authorization: ActivityAuthorizationPort,
    private readonly unitOfWork: ActivityUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  async execute(principal: string | null, input: unknown): Promise<{ activity: Activity; created: boolean }> {
    const { requestId, role: requestedRole, target, ...content } = parseRecordActivityInput(this.kind, input);
    // 認可は対象の存在確認より先に行い、Grantを持たないPrincipalへProject・Workspaceの存在を漏らさない。
    const actor = await this.authorization.resolveActor(principal, target, requestedRole);
    if (actor === null) {
      throw new ValidationError("Activity input is invalid", [
        { path: "role", message: "role is required when the operation context has no active role" },
      ]);
    }
    // 再送の照合は対象の状態・Resourceの検査より先に行う。成功済みの記録は、後でProject・Workspaceがarchiveされても
    // 参照Resourceが外れても、通信断後の再送で同じActivityを返せるようにする。
    const hash = inputHash({ ...content, target, role: actor.role });
    const dedupeKey = `recorded:${actor.principalId}:${requestId}`;
    return this.unitOfWork.execute(async (store, scopes) => {
      const saved = await store.findByDedupeKey(dedupeKey);
      if (saved) return { activity: this.replayed(saved, hash, requestId), created: false };

      const state = await scopes.find(target);
      if (!state) throw targetNotFound(target);
      if (state.archived) {
        const label = scopeLabels[target.kind];
        throw new ConflictError(`${label} ${target.id} is archived and can no longer be changed`, { [`${target.kind}Status`]: "archived" });
      }
      const unknownResources = content.refs.flatMap((ref, index) =>
        ref.kind === "project_resource" && !state.resourceIds.includes(ref.resourceId)
          ? [{
              path: `refs.${index}.resourceId`,
              message: target.kind === ActivityScope.PROJECT
                ? `Project Resource ${ref.resourceId} is not registered in this Project`
                : `Project Resource ${ref.resourceId} is not registered in a Project of this Workspace`,
            }]
          : [],
      );
      if (unknownResources.length) throw new ValidationError("Activity input is invalid", unknownResources);
      if (content.correctsActivityId !== undefined) {
        const corrected = await store.find(content.correctsActivityId);
        if (!corrected || !belongsTo(corrected, target, state)) {
          throw new NotFoundError(`Activity ${content.correctsActivityId} was not found in this ${scopeLabels[target.kind]}`);
        }
      }

      const now = this.clock();
      const { activity, created, inputHash: savedHash } = await store.append({
        id: this.newId(),
        scope: target.kind,
        workspaceId: state.workspaceId,
        projectId: state.projectId,
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
        dedupeKey,
        inputHash: hash,
      });
      return { activity: created ? activity : this.replayed({ activity, inputHash: savedHash }, hash, requestId), created };
    });
  }

  /** 同じ`requestId`の保存済みActivity。別の内容での再利用は`CONFLICT`。 */
  private replayed(saved: { activity: Activity; inputHash: string | null }, hash: string, requestId: string): Activity {
    if (saved.inputHash !== hash) {
      throw new ConflictError(`requestId ${requestId} was already used for a different Activity`, { activityId: saved.activity.id });
    }
    return saved.activity;
  }
}

/**
 * Project・WorkspaceのActivity一覧（summaryとrefsだけ。本文は`GetActivityUseCase`で取得する）。scopeはinstanceごとに固定し、
 * Workspaceの一覧に所属ProjectのActivityは含めない。認可は呼び出し側（Agent・Human）の入口で行う。
 * `afterCursor`は昇順の差分取得、それ以外は新しい順で、`nextCursor`を次の`afterCursor` / `beforeCursor`に渡す。
 */
export class ListActivitiesUseCase {
  constructor(
    private readonly kind: ActivityTargetKind,
    private readonly scopes: ActivityScopeReader,
    private readonly store: ActivityStore,
  ) {}

  async execute(scopeId: string, query: ActivityQueryInput = {}): Promise<ActivityPage> {
    const { refKind, refId, ...parsed } = parseActivityQuery(query);
    const target = { kind: this.kind, id: scopeId };
    if (!(await this.scopes.find(target))) throw targetNotFound(target);
    const storeQuery = {
      ...parsed,
      ...(refKind !== undefined && refId !== undefined ? { ref: { kind: refKind, id: refId } } : {}),
    };
    const activities = this.kind === ActivityScope.PROJECT
      ? await this.store.listProject(scopeId, storeQuery)
      : await this.store.listWorkspace(scopeId, storeQuery);
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

/** Activity 1件の本文・refsと、それを訂正したActivity。別scope・別Project・別Workspaceのidは存在しないものとして扱う。 */
export class GetActivityUseCase {
  constructor(
    private readonly kind: ActivityTargetKind,
    private readonly scopes: ActivityScopeReader,
    private readonly store: ActivityStore,
  ) {}

  async execute(scopeId: string, activityId: string): Promise<ActivityDetail> {
    const target = { kind: this.kind, id: scopeId };
    const state = await this.scopes.find(target);
    if (!state) throw targetNotFound(target);
    const activity = await this.store.find(activityId);
    if (!activity || !belongsTo(activity, target, state)) throw activityNotFound(activityId);
    const corrections = await this.store.listCorrections(activityId);
    return { activity, corrections: corrections.map(toActivitySummary) };
  }
}

/**
 * Agent向けの参照。scopeのいずれかのGrant（activeRoleの指定時はそのRole）を要求してから委譲する。
 * Project GrantとWorkspace Grantは互いに継承しない（認可portの実装が保証する）。
 */
export class AgentActivityReader {
  constructor(
    private readonly kind: ActivityTargetKind,
    private readonly authorization: ActivityAuthorizationPort,
    private readonly list: ListActivitiesUseCase,
    private readonly get: GetActivityUseCase,
  ) {}

  async listActivities(principal: string | null, scopeId: string, query: ActivityQueryInput = {}) {
    await this.authorization.requireReader(principal, { kind: this.kind, id: scopeId });
    return this.list.execute(scopeId, query);
  }

  async getActivity(principal: string | null, scopeId: string, activityId: string) {
    await this.authorization.requireReader(principal, { kind: this.kind, id: scopeId });
    return this.get.execute(scopeId, activityId);
  }
}

/** Role Contextへ渡す最近のActivity summary。本文は含めない。 */
export const recentActivitySummaryLimit = 20;
