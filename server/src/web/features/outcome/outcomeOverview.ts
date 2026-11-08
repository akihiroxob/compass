import { request } from "../../api.ts";
import { workspaceApiPath } from "../../paths.ts";

// ---- Workspace横断のOutcome一覧・詳細の集計（serverの`WorkspaceOutcomeOverview`と同じ形）。 ----

export type TaskCounts = Record<"todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled", number>;

/** `no_target`: Target未設定、`not_planned`: 未起票、`no_countable_tasks`: Task0件または全て取消、`counted`: 分母あり。 */
export type TaskProgress = {
  kind: "no_target" | "not_planned" | "no_countable_tasks" | "counted";
  accepted: number;
  denominator: number;
  canceled: number;
  total: number;
  counts: TaskCounts;
  ratio: number | null;
};

export type OutcomeProblemFact = {
  consultationId: string;
  kind: "waiting_human" | "waiting_agent";
  scope: "project" | "workspace";
  title: string;
  reason: string;
  projectIds: string[];
  taskIds: string[];
  updatedAt: number;
};

export type OutcomeProblemSummary =
  | { state: "unknown" }
  | { state: "none" }
  | { state: "present"; representative: OutcomeProblemFact; otherCount: number; waitingHumanCount: number; waitingAgentCount: number; items: OutcomeProblemFact[] };

/**
 * 提供状況（公開）。Workの公開記録だけから、Target ProjectのOutcome相関Storyの変更ごとの公開状況を数える。
 * `unknown`は取得できなかったこと、`no_changes`は公開確認の対象になる変更が無いこと。Outcome全体の提供済みは判断しない。
 */
export type OutcomeDelivery =
  | { state: "unknown" }
  | { state: "no_changes" }
  | { state: "tracked"; changeCount: number; published: number; notPublished: number; unconfirmed: number; notConfigured: number };

/** 効果の確認状況。最新のEvaluationの結果だけで決める。 */
export type OutcomeEffect =
  | { state: "not_evaluated" }
  | { state: "evaluated"; result: "achieved" | "failed" | "insufficient_evidence"; evaluatedAt: number }
  | { state: "unknown" };

export type OutcomeOverview = {
  outcomeId: string;
  intentId: string;
  intentTitle: string;
  intentStatus: string;
  title: string;
  description: string;
  hypothesis: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  targets: { projectId: string; projectStatus: "active" | "archived"; progress: TaskProgress }[];
  progress: TaskProgress & { targetProjectCount: number; unplannedProjectCount: number };
  problems: OutcomeProblemSummary;
  delivery: OutcomeDelivery;
  effect: OutcomeEffect;
};

export type OutcomeOverviewPage = { items: OutcomeOverview[]; total: number; workspaceTotal: number; limit: number; offset: number };

export const outcomePageSize = 20;
export const outcomeProblemFilters = ["", "present", "none", "unknown"] as const;
export type OutcomeProblemFilter = (typeof outcomeProblemFilters)[number];

export type OutcomeListConditions = { q: string; intentId: string; problem: OutcomeProblemFilter; page: number };

export const emptyConditions: OutcomeListConditions = { q: "", intentId: "", problem: "", page: 1 };

/** URLのquery。条件はURLに保持し、詳細から戻っても同じ一覧を開く。 */
export const readConditions = (search: URLSearchParams): OutcomeListConditions => {
  const problem = search.get("problem") ?? "";
  const page = Number(search.get("page") ?? "1");
  return {
    q: search.get("q") ?? "",
    intentId: search.get("intentId") ?? "",
    problem: (outcomeProblemFilters as readonly string[]).includes(problem) ? (problem as OutcomeProblemFilter) : "",
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
};

export const conditionsSearch = (conditions: OutcomeListConditions): string => {
  const search = new URLSearchParams();
  if (conditions.q.trim()) search.set("q", conditions.q.trim());
  if (conditions.intentId) search.set("intentId", conditions.intentId);
  if (conditions.problem) search.set("problem", conditions.problem);
  if (conditions.page > 1) search.set("page", String(conditions.page));
  const text = search.toString();
  return text ? `?${text}` : "";
};

export const hasConditions = (conditions: OutcomeListConditions) => Boolean(conditions.q.trim() || conditions.intentId || conditions.problem);

export const loadOutcomeOverviews = (workspaceId: string, conditions: OutcomeListConditions): Promise<OutcomeOverviewPage> => {
  const query = new URLSearchParams({ limit: String(outcomePageSize), offset: String((conditions.page - 1) * outcomePageSize) });
  if (conditions.q.trim()) query.set("q", conditions.q.trim());
  if (conditions.intentId) query.set("intentId", conditions.intentId);
  if (conditions.problem) query.set("problem", conditions.problem);
  return request<OutcomeOverviewPage>(workspaceApiPath(workspaceId, `/outcomes?${query.toString()}`));
};

export const loadOutcomeOverview = (workspaceId: string, outcomeId: string): Promise<OutcomeOverview> =>
  request<OutcomeOverview>(workspaceApiPath(workspaceId, `/outcomes/${outcomeId}/overview`));

/** 進捗の文言。分母0を0%や完了にせず、対象なし・未起票・Task0件を区別する。取消は分母に含めず別に示す。 */
export const progressText = (progress: TaskProgress): string => {
  switch (progress.kind) {
    case "no_target": return "対象Projectなし";
    case "not_planned": return "未起票";
    case "no_countable_tasks": return progress.canceled > 0 ? `対象Taskなし（取消${progress.canceled}件のみ）` : "Task 0件";
    case "counted": return `受入済み ${progress.accepted} / ${progress.denominator}件`;
  }
};

export const progressPercent = (progress: TaskProgress): string | null =>
  progress.ratio === null ? null : `${Math.round(progress.ratio * 100)}%`;

export const problemKindLabels: Record<OutcomeProblemFact["kind"], string> = { waiting_human: "Human待ち", waiting_agent: "Agentが対処" };

export const problemFilterLabels: Record<OutcomeProblemFilter, string> = { "": "すべて", present: "問題あり", none: "問題なし", unknown: "未取得" };
