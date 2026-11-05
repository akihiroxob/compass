// ---- Activity閲覧。Web API（`/api/projects/:projectId/activities`・`/api/workspaces/:workspaceId/activities`と各`/:activityId`）の応答の型と表示用の変換。 ----

export type ActivityReference =
  | { kind: "project_resource"; resourceId: string; path: string | null; revision: string | null }
  | { kind: "url"; url: string }
  | { kind: "intent" | "outcome" | "research_request" | "decision" | "story" | "task" | "activity" | "consultation" | "workspace_consultation"; id: string };

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
export type ActivityPage = { activities: ActivitySummary[]; nextCursor: number | string | null; matchedCount?: number };
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
    { label: "Story", types: [{ type: "story.created", label: "Storyの起票" }, { type: "story.started", label: "Storyの着手" }, { type: "story.completed", label: "Storyの完了" }, { type: "story.canceled", label: "Storyの取消" }] },
    {
      label: "Task",
      types: [
        { type: "task.created", label: "Taskの起票" },
        { type: "task.started", label: "Taskの着手" },
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
  workspace_consultation: "Workspace相談",
};

/**
 * 参照の表示。成果物は正本（Repository / Docs・URL）へのlinkだけを出し、本文はCompassに無い。
 * - `href`: 外部へのlink。`screen`: Web UI内で辿れる画面の対象。どちらも無ければIDだけを出す。
 */
export type ReferenceView = {
  label: string;
  detail: string | null;
  href?: string;
  screen?: { kind: "task" | "intent" | "research_request" | "consultation" | "workspace_consultation"; id: string } | { kind: "outcome"; id: string; intentId: string };
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
  if (ref.kind === "task" || ref.kind === "intent" || ref.kind === "research_request" || ref.kind === "consultation" || ref.kind === "workspace_consultation") {
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
  nextCursor: number | string | null;
  /** 条件に一致する件数（横断一覧だけ）。 */
  matchedCount: number | null;
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
  matchedCount: null,
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
      return { ...state, activities: action.page.activities, nextCursor: action.page.nextCursor, matchedCount: action.page.matchedCount ?? null };
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

// ---- Workspace横断Activity（`GET /api/workspaces/:workspaceId/activity-stream`）。条件はURLのqueryで持ち、再読込・共有・詳細からの復帰で保たれる。 ----

export type ActivityStreamPage = { activities: ActivitySummary[]; nextCursor: string | null; matchedCount: number };

/**
 * 横断一覧の条件。`target`はnull=すべての記録（Workspace共通と所属全Project）、`"workspace"`=Workspace共通だけ、それ以外はProjectのID。
 * `from` / `to`は日付（`YYYY-MM-DD`、端を含む）、`q`は検索語。
 */
export type ActivityStreamFilter = { target: string | null; type: string | null; q: string; from: string | null; to: string | null };

export const workspaceCommonTarget = "workspace";
export const maximumSearchLength = 200;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const parseDate = (value: string | null): string | null => (value !== null && datePattern.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00`)) ? value : null);

/** URLのquery。外部から入力できる値なので、形式外は条件なしとして扱う。 */
export const parseActivityStreamFilter = (params: URLSearchParams): ActivityStreamFilter => {
  const target = params.get("target");
  return {
    target: target !== null && target.length > 0 && target.length <= 100 ? target : null,
    type: parseActivityTypeFilter(params.get("type")),
    q: (params.get("q") ?? "").trim().slice(0, maximumSearchLength),
    from: parseDate(params.get("from")),
    to: parseDate(params.get("to")),
  };
};

const filterKeys = ["target", "type", "q", "from", "to"] as const;

export const hasActivityStreamFilter = (filter: ActivityStreamFilter): boolean =>
  filter.target !== null || filter.type !== null || filter.q !== "" || filter.from !== null || filter.to !== null;

/** 条件を置き換えたsearch。条件以外のquery（詳細の`record`等）は残す。空の条件はqueryに付けない。 */
export const activityStreamSearch = (current: URLSearchParams, patch: Partial<ActivityStreamFilter>): string => {
  const next = new URLSearchParams(current);
  for (const key of filterKeys) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === null || value === undefined || value === "") next.delete(key);
    else next.set(key, value);
  }
  const search = next.toString();
  return search ? `?${search}` : "";
};

/** すべての条件を解除したsearch。詳細の`record`は残す。 */
export const clearedActivityStreamSearch = (current: URLSearchParams): string =>
  activityStreamSearch(current, { target: null, type: null, q: "", from: null, to: null });

/** 開始日が終了日より後なら、serverへ送らずに利用者へ知らせる。 */
export const isActivityPeriodInvalid = ({ from, to }: Pick<ActivityStreamFilter, "from" | "to">): boolean => from !== null && to !== null && from > to;

/** 日付（端を含む）を、利用者の時間帯の発生時刻（epoch ms）の範囲へ換える。 */
export const activityPeriodRange = ({ from, to }: Pick<ActivityStreamFilter, "from" | "to">): { from?: number; to?: number } => ({
  ...(from === null ? {} : { from: new Date(`${from}T00:00:00`).getTime() }),
  ...(to === null ? {} : { to: new Date(`${to}T23:59:59.999`).getTime() }),
});

export const activityStreamPath = (workspaceId: string, filter: ActivityStreamFilter, { before = null, limit = 20 }: { before?: string | null; limit?: number } = {}) => {
  const query = new URLSearchParams({ limit: String(limit) });
  if (before !== null) query.set("before", before);
  if (filter.target === workspaceCommonTarget) query.set("workspaceOnly", "true");
  else if (filter.target !== null) query.set("projectId", filter.target);
  if (filter.type !== null) query.set("type", filter.type);
  if (filter.q !== "") query.set("q", filter.q);
  const range = activityPeriodRange(filter);
  if (range.from !== undefined) query.set("from", String(range.from));
  if (range.to !== undefined) query.set("to", String(range.to));
  return `/api/workspaces/${workspaceId}/activity-stream?${query}`;
};

/** 横断一覧の種別。Work（Project）とDirection（Workspace）の状態変更を並べる。明示記録の種別は自由なため、一覧の種別から絞り込む。 */
export const activityStreamTypeGroups = [...activityTypeGroups.project, ...activityTypeGroups.workspace];
export const activityStreamTypeLabel = (type: string): string | null => activityTypeLabel("project", type) ?? activityTypeLabel("workspace", type);

/** 記録1件の詳細を引くscope。Workspace共通はWorkspace、Projectの記録はProjectのActivity。 */
export const activityScopeOf = (activity: Pick<ActivitySummary, "workspaceId" | "projectId">): ActivityScope =>
  activity.projectId === null ? { kind: "workspace", workspaceId: activity.workspaceId } : { kind: "project", projectId: activity.projectId };

/** 詳細を開いている記録。URLの`record`（ID）と、Projectの記録なら`recordProject`。 */
export const activityRecordSearch = (current: URLSearchParams, record: Pick<ActivitySummary, "id" | "projectId"> | null): string => {
  const next = new URLSearchParams(current);
  next.delete("record");
  next.delete("recordProject");
  if (record !== null) {
    next.set("record", record.id);
    if (record.projectId !== null) next.set("recordProject", record.projectId);
  }
  const search = next.toString();
  return search ? `?${search}` : "";
};

export const parseActivityRecord = (params: URLSearchParams, workspaceId: string): { id: string; scope: ActivityScope } | null => {
  const id = params.get("record");
  if (id === null || id.length === 0 || id.length > 100) return null;
  const projectId = params.get("recordProject");
  return { id, scope: projectId ? { kind: "project", projectId } : { kind: "workspace", workspaceId } };
};

/** 新しい順の一覧を、利用者の時間帯の日付ごとにまとめる。順序は保つ。 */
export const groupActivitiesByDate = (activities: readonly ActivitySummary[]): { date: string; label: string; activities: ActivitySummary[] }[] => {
  const groups: { date: string; label: string; activities: ActivitySummary[] }[] = [];
  for (const activity of activities) {
    const day = new Date(activity.occurredAt);
    const date = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
    const last = groups.at(-1);
    if (last?.date === date) last.activities.push(activity);
    else groups.push({ date, label: day.toLocaleDateString("ja-JP", { year: "numeric", month: "long", day: "numeric", weekday: "short" }), activities: [activity] });
  }
  return groups;
};

/** Taskの状態変更の注記。レビュー・受入は公開やOutcomeの達成を意味しない。 */
export const activityTypeNote = (type: string): string | null =>
  type === "task.accepted" || type === "task.reviewed"
    ? "Taskの工程の記録です。公開の確認やOutcomeの達成を意味しません。それらは別の事実として扱います。"
    : null;
