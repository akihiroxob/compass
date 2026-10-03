// ---- Activity閲覧。Web API（`/api/projects/:projectId/activities`・`activities/:activityId`）の応答の型と表示用の変換。 ----

export type ActivityReference =
  | { kind: "project_resource"; resourceId: string; path: string | null; revision: string | null }
  | { kind: "url"; url: string }
  | { kind: "intent" | "outcome" | "research_request" | "decision" | "story" | "task" | "activity"; id: string };

export type ActivitySummary = {
  id: string;
  cursor: number;
  projectId: string;
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

export const activitiesPath = (projectId: string, beforeCursor: number | null = null, limit = 20) =>
  `/api/projects/${projectId}/activities?limit=${limit}${beforeCursor === null ? "" : `&beforeCursor=${beforeCursor}`}`;
export const activityPath = (projectId: string, activityId: string) => `/api/projects/${projectId}/activities/${activityId}`;

export const activitySourceLabels: Record<ActivitySummary["source"], string> = { recorded: "記録", canonical: "状態変更" };

const entityLabels: Record<Exclude<ActivityReference["kind"], "project_resource" | "url">, string> = {
  intent: "Intent",
  outcome: "Outcome",
  research_request: "Research Request",
  decision: "Decision",
  story: "Story",
  task: "Task",
  activity: "Activity",
};

/**
 * 参照の表示。成果物は正本（Repository / Docs・URL）へのlinkだけを出し、本文はCompassに無い。
 * - `href`: 外部へのlink。`screen`: Web UI内で辿れる画面の対象。どちらも無ければIDだけを出す。
 */
export type ReferenceView = {
  label: string;
  detail: string | null;
  href?: string;
  screen?: { kind: "task" | "intent" | "research_request"; id: string };
};

export const describeReference = (
  ref: ActivityReference,
  resources: readonly ProjectResourceLink[],
): ReferenceView => {
  if (ref.kind === "url") return { label: ref.url, detail: null, href: ref.url };
  if (ref.kind === "project_resource") {
    const resource = resources.find(({ id }) => id === ref.resourceId);
    const detail = [ref.path, ref.revision ? `@ ${ref.revision.slice(0, 12)}` : null].filter(Boolean).join(" ") || null;
    return resource
      ? { label: resource.name, detail, href: resource.url }
      : { label: `登録が外れたResource ${ref.resourceId}`, detail };
  }
  const label = `${entityLabels[ref.kind]} ${ref.id.slice(0, 8)}`;
  if (ref.kind === "task" || ref.kind === "intent" || ref.kind === "research_request") {
    return { label, detail: null, screen: { kind: ref.kind, id: ref.id } };
  }
  return { label, detail: null };
};

/** 古いページを末尾へ足す。cursorが重複したもの（読込中に追記された等）は除く。 */
export const appendActivityPage = (existing: ActivitySummary[], page: ActivitySummary[]): ActivitySummary[] => {
  const seen = new Set(existing.map(({ cursor }) => cursor));
  return [...existing, ...page.filter(({ cursor }) => !seen.has(cursor))];
};
