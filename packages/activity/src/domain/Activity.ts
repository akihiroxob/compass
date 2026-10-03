/**
 * Activity: Project / System上で何が起き、何が分かり、何が決まったかを、後から人間やAgentが理解するための履歴。
 * raw log（Operational Log）や正確な状態変更（Change Log）とは別の概念で、workflow checkpointにも使わない。
 * Agentの実行単位（runId）は持たない。訂正は過去のActivityを書き換えず、`correctsActivityId`を持つActivityを追記する。
 */

export const ActivityScope = {
  PROJECT: "project",
  /** Agent System共通の履歴。`projectId`を持たない。 */
  SYSTEM: "system",
} as const;

export type ActivityScope = (typeof ActivityScope)[keyof typeof ActivityScope];

export const activityScopes = Object.values(ActivityScope) as [ActivityScope, ...ActivityScope[]];

/**
 * - `recorded`: Agent等が明示的に記録した意味的Activity（調査結果・判断理由・決定・引き継ぎ等）。
 * - `canonical`: 重要な状態変更から、状態変更と同じtransactionでserverが自動生成したActivity。
 */
export type ActivitySource = "recorded" | "canonical";

/** COMPASS内部のEntityへの参照。本文は持たず、IDだけで正本を辿らせる。 */
export const activityEntityKinds = ["intent", "outcome", "research_request", "decision", "story", "task", "activity"] as const;

export type ActivityEntityKind = (typeof activityEntityKinds)[number];

/**
 * Activityの参照。Project側の成果物（Repository / Docsが正本）は本文を複製せず、所在（Project Resource + path + revision・URL）だけを持つ。
 * - `project_resource`: Projectに登録済みのRepository・Resourceの`resourceId`。`path`・`revision`（commit SHA等）は任意。
 * - `url`: 外部の成果物のURL。
 */
export type ActivityReference =
  | { kind: "project_resource"; resourceId: string; path: string | null; revision: string | null }
  | { kind: "url"; url: string }
  | { kind: ActivityEntityKind; id: string };

export type Activity = {
  readonly id: string;
  /** 全体で単調増加する取得位置。差分取得・ページングに使い、workflow checkpointには使わない。 */
  readonly cursor: number;
  readonly scope: ActivityScope;
  /** `scope=project`では必須、`scope=system`ではnull。 */
  readonly projectId: string | null;
  /** 例: `research.summary`・`decision.recorded`・`task.completed`。完全な列挙は定めない。 */
  readonly type: string;
  /** 誰が行ったか。 */
  readonly principalId: string;
  /** 何の立場で行ったか（Project Role等）。 */
  readonly role: string;
  readonly summary: string;
  /** 任意のMarkdown本文。 */
  readonly body: string | null;
  readonly refs: ActivityReference[];
  /** 訂正対象のActivity。訂正ではないActivityはnull。 */
  readonly correctsActivityId: string | null;
  readonly source: ActivitySource;
  readonly occurredAt: number;
  /** 保存した時刻。`occurredAt`は行為の時刻で、明示記録では呼び出し側が過去の時刻を指定できる。 */
  readonly recordedAt: number;
};

/** 一覧の項目。`body`は含めず、要否を`hasBody`で示す（summaryを読んでから必要なActivityの本文だけを取得させる）。 */
export type ActivitySummary = Omit<Activity, "body"> & { readonly hasBody: boolean };

export const toActivitySummary = ({ body, ...activity }: Activity): ActivitySummary => ({ ...activity, hasBody: body !== null });
