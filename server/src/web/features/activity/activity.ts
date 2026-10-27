// ---- Activity閲覧。Web API（`/api/projects/:projectId/activities`・`/api/workspaces/:workspaceId/activities`と各`/:activityId`）の応答の型と表示用の変換。 ----

export type ActivityReference =
  | { kind: "project_resource"; resourceId: string; path: string | null; revision: string | null }
  | { kind: "url"; url: string }
  | { kind: "intent" | "outcome" | "research_request" | "decision" | "story" | "task" | "activity" | "consultation"; id: string };

export type ActivitySummary = {
  id: string;
  cursor: number;
  scope: "project" | "workspace";
  workspaceId: string;
  /** Workspace Activity（Direction等）ではnull。 */
  projectId: string | null;
  type: string;
  principalId: string;
  role: string;
  summary: string;
  refs: ActivityReference[];
  correctsActivityId: string | null;
  source: "recorded" | "canonical";
  occurredAt: number;
  hasBody: boolean;
};

export type Activity = Omit<ActivitySummary, "hasBody"> & { body: string | null };
export type ActivityPage = { activities: ActivitySummary[]; nextCursor: number | null };
export type ActivityDetail = { activity: Activity; corrections: ActivitySummary[] };

/** Projectに登録済みのRepository・Resource。`project_resource`参照の表示名・URLを引く。 */
export type ProjectResourceLink = { id: string; name: string; url: string };

/** 閲覧するActivityのscope。Project ActivityとWorkspace Activityは別のWeb APIで、互いを含めない。 */
export type ActivityScope = { kind: "project"; projectId: string } | { kind: "workspace"; workspaceId: string };

const activityScopePath = (scope: ActivityScope) =>
  scope.kind === "project" ? `/api/projects/${scope.projectId}/activities` : `/api/workspaces/${scope.workspaceId}/activities`;
/** 新しい順の1ページ。`beforeCursor`で古いページ、`type`で種別（完全一致）に絞る。 */
export const activitiesPath = (
  scope: ActivityScope,
  { beforeCursor = null, type = null, limit = 20 }: { beforeCursor?: number | null; type?: string | null; limit?: number } = {},
) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (beforeCursor !== null) query.set("beforeCursor", String(beforeCursor));
  if (type !== null) query.set("type", type);
  return `${activityScopePath(scope)}?${query}`;
};
export const activityPath = (scope: ActivityScope, activityId: string) => `${activityScopePath(scope)}/${activityId}`;

export const activitySourceLabels: Record<ActivitySummary["source"], string> = { recorded: "記録", canonical: "状態変更" };

// ---- 種別の絞り込み。URLの`?type=`で表し、serverの`type`（完全一致）へそのまま渡す。 ----

/**
 * scopeごとの状態変更（canonical）の種別。Project ActivityはWorkの履歴、Workspace ActivityはDirectionの判断の履歴で、互いの種別を含めない。
 * Agentの明示記録の種別は自由なため、一覧の種別から同じ種別だけを絞り込む。
 */
export const activityTypeGroups: Record<ActivityScope["kind"], { label: string; types: { type: string; label: string }[] }[]> = {
  project: [
    { label: "Story", types: [{ type: "story.created", label: "Storyの起票" }, { type: "story.completed", label: "Storyの完了" }, { type: "story.canceled", label: "Storyの取消" }] },
    {
      label: "Task",
      types: [
        { type: "task.created", label: "Taskの起票" },
        { type: "task.completed", label: "Taskの作業完了" },
        { type: "task.reviewed", label: "Taskのレビュー承認" },
        { type: "task.accepted", label: "Taskの受入" },
        { type: "task.rejected", label: "Taskの差戻し" },
        { type: "task.canceled", label: "Taskの取消" },
      ],
    },
    { label: "Project", types: [{ type: "project.archived", label: "Projectのアーカイブ" }] },
  ],
  workspace: [
    { label: "Intent", types: [{ type: "intent.created", label: "Intentの作成" }, { type: "intent.abandoned", label: "Intentの放棄" }] },
    { label: "Outcome", types: [{ type: "outcome.confirmed", label: "Outcomeの確定" }, { type: "outcome.canceled", label: "Outcomeの取消" }, { type: "outcome.evaluated", label: "Outcomeの評価" }] },
    { label: "Research", types: [{ type: "research.requested", label: "Researchの依頼" }, { type: "research.closed", label: "Researchの終了" }] },
    { label: "Decision", types: [{ type: "decision.recorded", label: "Direction Decisionの記録" }] },
  ],
};

/** 状態変更の種別の表示名。明示記録など一覧に無い種別はnull。 */
export const activityTypeLabel = (kind: ActivityScope["kind"], type: string): string | null =>
  activityTypeGroups[kind].flatMap(({ types }) => types).find((item) => item.type === type)?.label ?? null;

/** serverの種別の形式（`research.summary`等）。外部から入力できるURLの値なので、形式外は絞り込まない（全件）として扱う。 */
const activityTypePattern = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/;
export const parseActivityTypeFilter = (value: string | null): string | null =>
  value !== null && value.length <= 100 && activityTypePattern.test(value) ? value : null;

/** 現在のqueryの`type`だけを置き換えたsearch。`view`等の他のqueryは残し、全件はqueryを付けない。 */
export const activityTypeSearch = (current: URLSearchParams, type: string | null): string => {
  const next = new URLSearchParams(current);
  if (type === null) next.delete("type");
  else next.set("type", type);
  const search = next.toString();
  return search ? `?${search}` : "";
};

const entityLabels: Record<Exclude<ActivityReference["kind"], "project_resource" | "url">, string> = {
  intent: "Intent",
  outcome: "Outcome",
  research_request: "Research Request",
  decision: "Decision",
  story: "Story",
  task: "Task",
  activity: "Activity",
  consultation: "相談",
};

/**
 * 参照の表示。成果物は正本（Repository / Docs・URL）へのlinkだけを出し、本文はCompassに無い。
 * - `href`: 外部へのlink。`screen`: Web UI内で辿れる画面の対象。どちらも無ければIDだけを出す。
 */
export type ReferenceView = {
  label: string;
  detail: string | null;
  href?: string;
  screen?: { kind: "task" | "intent" | "research_request" | "consultation"; id: string } | { kind: "outcome"; id: string; intentId: string };
};

/**
 * `resources`がnullなら参照先の一覧を取得できていないため、登録が外れたとは断定せずIDだけを出す。
 * `siblings`は同じActivityの参照。OutcomeのWorkspace画面はIntentのIDも要るため、同じActivityがIntentを1件だけ参照するときだけ辿る
 * （DirectionのOutcome・Evaluation等の状態変更はOutcomeとIntentを併せて参照する）。
 */
export const describeReference = (
  ref: ActivityReference,
  resources: readonly ProjectResourceLink[] | null,
  siblings: readonly ActivityReference[] = [],
): ReferenceView => {
  if (ref.kind === "url") return { label: ref.url, detail: null, href: ref.url };
  if (ref.kind === "project_resource") {
    const resource = resources?.find(({ id }) => id === ref.resourceId);
    const detail = [ref.path, ref.revision ? `@ ${ref.revision.slice(0, 12)}` : null].filter(Boolean).join(" ") || null;
    return resource
      ? { label: resource.name, detail, href: resource.url }
      : { label: resources === null ? `Resource ${ref.resourceId}` : `登録が外れたResource ${ref.resourceId}`, detail };
  }
  const label = `${entityLabels[ref.kind]} ${ref.id.slice(0, 8)}`;
  if (ref.kind === "task" || ref.kind === "intent" || ref.kind === "research_request" || ref.kind === "consultation") {
    return { label, detail: null, screen: { kind: ref.kind, id: ref.id } };
  }
  if (ref.kind === "outcome") {
    const intentIds = siblings.flatMap((sibling) => (sibling.kind === "intent" ? [sibling.id] : []));
    if (intentIds.length === 1) return { label, detail: null, screen: { kind: "outcome", id: ref.id, intentId: intentIds[0]! } };
  }
  return { label, detail: null };
};

/** 古いページを末尾へ足す。cursorが重複したもの（読込中に追記された等）は除く。 */
export const appendActivityPage = (existing: ActivitySummary[], page: ActivitySummary[]): ActivitySummary[] => {
  const seen = new Set(existing.map(({ cursor }) => cursor));
  return [...existing, ...page.filter(({ cursor }) => !seen.has(cursor))];
};

/**
 * 一覧の読込状態。`key`は取得条件（scopeと種別）、`generation`は取得の世代で、条件が変わるたびに新しい世代で`reset`する。
 * 応答は要求時の`generation`を添えて渡し、現在の世代と異なる応答の成功・失敗・完了は無視する。
 * 条件の文字列だけでは`A → B → A`と同じ条件へ戻ったときに旧要求と区別できないため、世代で判定する。
 */
export type ActivityListState = {
  key: string;
  generation: number;
  activities: ActivitySummary[] | null;
  nextCursor: number | null;
  error: string | null;
  moreError: string | null;
  pending: boolean;
  /** 追加読込で最後のページに達した。 */
  reachedEnd: boolean;
};

export type ActivityListAction =
  | { kind: "reset"; key: string; generation: number }
  | { kind: "loaded"; generation: number; page: ActivityPage }
  | { kind: "failed"; generation: number; message: string }
  | { kind: "moreStarted"; generation: number }
  | { kind: "moreLoaded"; generation: number; page: ActivityPage }
  | { kind: "moreFailed"; generation: number; message: string };

export const initialActivityList = (key: string, generation = 0): ActivityListState => ({
  key,
  generation,
  activities: null,
  nextCursor: null,
  error: null,
  moreError: null,
  pending: false,
  reachedEnd: false,
});

export const activityListReducer = (state: ActivityListState, action: ActivityListAction): ActivityListState => {
  if (action.kind === "reset") return initialActivityList(action.key, action.generation);
  if (action.generation !== state.generation) return state;
  switch (action.kind) {
    case "loaded":
      return { ...state, activities: action.page.activities, nextCursor: action.page.nextCursor };
    case "failed":
      return { ...state, error: action.message };
    case "moreStarted":
      return { ...state, pending: true, moreError: null };
    case "moreLoaded":
      return {
        ...state,
        activities: appendActivityPage(state.activities ?? [], action.page.activities),
        nextCursor: action.page.nextCursor,
        pending: false,
        reachedEnd: action.page.nextCursor === null,
      };
    case "moreFailed":
      return { ...state, moreError: action.message, pending: false };
  }
};
