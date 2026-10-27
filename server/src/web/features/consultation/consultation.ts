// 相談（判断待ち）の型・Web API path・表示の判定。表示から分けた純関数で、導線の表示だけを決める（拒否は常にserverが行う）。
// Project相談とWorkspace相談は同じ型・同じ画面部品で扱い、scope（`ConsultationScope`）でpathと辿り先を切り替える。
// テストからも読み込むため、純関数のmodule以外をimportしない。
import {
  consultationStatuses,
  scopeOfConsultation,
  type Consultation,
  type ConsultationActor,
  type ConsultationArtifact,
  type ConsultationFollowup,
  type ConsultationMessage,
  type ConsultationReference,
  type ConsultationResolution,
  type ConsultationScope,
  type ConsultationStatus,
  type FollowupKind,
  type FollowupTaskStatus,
  type ReflectionStatus,
  type ResolutionSource,
} from "@compass/collaboration/domain";
import { consultationInboxPath, consultationPath, projectViewPath, taskPath, workspaceApiPath, workspaceConsultationPath, workspaceOutcomePath, workspacePath } from "../../paths.ts";
import type { StatusTone } from "../../statusTone.ts";
import { describePrincipal, storyAnchorId, taskStatusLabels, taskStatusTones } from "../execution/model.ts";

export type { Consultation, ConsultationActor, ConsultationMessage, ConsultationReference, ConsultationResolution, ConsultationScope, ConsultationStatus };
export { scopeOfConsultation };

/** 現在応答中のAgent（有効な応答lease）。 */
export type ConsultationResponder = { principalId: string; role: string; inputRevision: number; expiresAt: number };

/** 結論からの文書反映の依頼と、Taskの状態・受入済み成果物参照から求めた反映状況。 */
export type ConsultationFollowupView = ConsultationFollowup & {
  task: { id: string; title: string; status: FollowupTaskStatus } | null;
  repository: { id: string; name: string; url: string } | null;
  status: ReflectionStatus;
  blocksResumption: boolean;
  artifacts: ConsultationArtifact[];
};

/** この相談を待つTask（元Task）。 */
export type ConsultationWaitingTask = {
  taskId: string;
  title: string;
  status: FollowupTaskStatus;
  phase: "work" | "review" | "acceptance";
  state: "waiting" | "ready" | "resuming";
  failureReason: string | null;
};

/** `GET /api/projects/:projectId/consultations/:consultationId`・`GET /api/workspaces/:workspaceId/consultations/:consultationId`の応答。 */
export type ConsultationDetail = {
  consultation: Consultation;
  messages: ConsultationMessage[];
  resolution: ConsultationResolution | null;
  responder: ConsultationResponder | null;
  followups: ConsultationFollowupView[];
  waitingTasks: ConsultationWaitingTask[];
};

export const consultationStatusLabels: Record<ConsultationStatus, string> = {
  waiting_human: "Humanの判断待ち",
  waiting_agent: "Agentの応答待ち",
  resolved: "解決済み",
  canceled: "取消",
};

export const consultationStatusTones: Record<ConsultationStatus, StatusTone> = {
  waiting_human: "attention",
  waiting_agent: "progress",
  resolved: "done",
  canceled: "muted",
};

export const resolutionSourceLabels: Record<ResolutionSource, string> = {
  human_decision: "Humanの決定",
  agent_summary: "Humanの返信からAgentが整理した結論",
};

// ---- 文書反映と元Task。反映状況は相談の解決（resolved）と別に、文書反映Taskの状態と受入済み成果物参照から出す。 ----

export const followupKindLabels: Record<FollowupKind, string> = { adr: "ADR", specification: "仕様", policy: "Policy" };

export const reflectionStatusLabels: Record<ReflectionStatus, string> = {
  pending: "反映待ち",
  in_progress: "対応中",
  reflected: "反映済み",
  canceled: "取消",
};

export const reflectionStatusTones: Record<ReflectionStatus, StatusTone> = {
  pending: "waiting",
  in_progress: "progress",
  reflected: "done",
  canceled: "muted",
};

/** 反映状況の補足。受入済みで参照の登録待ち・Taskが見つからない場合を区別する。 */
export const describeReflection = (followup: Pick<ConsultationFollowupView, "status" | "task" | "artifacts">): string => {
  if (!followup.task) return "文書反映Taskが見つかりません";
  if (followup.status === "in_progress" && followup.task.status === "accepted") return "Taskは受入済みです。成果物の参照の登録を待っています";
  return `文書反映Task: ${taskStatusLabels[followup.task.status]}`;
};

export { taskStatusLabels, taskStatusTones };

export const waitStateLabels: Record<ConsultationWaitingTask["state"], string> = { waiting: "相談の結論待ち", ready: "再開待ち", resuming: "再開中" };
export const waitPhaseLabels: Record<ConsultationWaitingTask["phase"], string> = { work: "作業", review: "レビュー", acceptance: "受入" };

// ---- 一覧の絞り込み。Project・Workspaceの「判断待ち」と横断一覧で`?status=`に表す。既定はHumanの判断待ち。 ----

export const consultationFilters = [...consultationStatuses, "all"] as const;
export type ConsultationFilter = (typeof consultationFilters)[number];

export const consultationFilterLabels: Record<ConsultationFilter, string> = { ...consultationStatusLabels, all: "すべて" };

export const parseConsultationFilter = (value: string | null): ConsultationFilter =>
  consultationFilters.find((filter) => filter === value) ?? "waiting_human";

/** 絞り込みのquery。`view`等の他のqueryは残し、既定（Humanの判断待ち）はqueryを付けない。 */
export const consultationFilterSearch = (current: URLSearchParams, filter: ConsultationFilter): string => {
  const next = new URLSearchParams(current);
  if (filter === "waiting_human") next.delete("status");
  else next.set("status", filter);
  const search = next.toString();
  return search ? `?${search}` : "";
};

// ---- scopeごとの画面・Web API path。ProjectはProject詳細の「判断待ち」view、WorkspaceはWorkspaceの「判断待ち」。 ----

export const projectConsultationScope = (projectId: string): ConsultationScope => ({ kind: "project", projectId });
export const workspaceConsultationScope = (workspaceId: string): ConsultationScope => ({ kind: "workspace", workspaceId });

/** scopeのWeb APIのpath（`/api/projects/:projectId`・`/api/workspaces/:workspaceId`）。 */
export const consultationScopeApiPath = (scope: ConsultationScope) =>
  scope.kind === "project" ? `/api/projects/${scope.projectId}` : workspaceApiPath(scope.workspaceId);

/** scopeの一覧画面。 */
export const consultationListPath = (scope: ConsultationScope) =>
  scope.kind === "project" ? projectViewPath(scope.projectId, "consultations") : workspacePath(scope.workspaceId, "consultations");

/** 相談の詳細画面。 */
export const consultationDetailPath = (scope: ConsultationScope, consultationId: string) =>
  scope.kind === "project" ? consultationPath(scope.projectId, consultationId) : workspaceConsultationPath(scope.workspaceId, consultationId);

export const consultationsApiPath = (scope: ConsultationScope, filter: ConsultationFilter = "all") =>
  `${consultationScopeApiPath(scope)}/consultations${filter === "all" ? "" : `?status=${filter}`}`;

export const consultationApiPath = (scope: ConsultationScope, consultationId: string, suffix: "" | "/messages" | "/resolution" | "/cancel" = "") =>
  `${consultationScopeApiPath(scope)}/consultations/${consultationId}${suffix}`;

export const consultationScopeLabels: Record<ConsultationScope["kind"], "Project" | "Workspace"> = { project: "Project", workspace: "Workspace" };

export const isOpenConsultation = (status: ConsultationStatus) => status === "waiting_human" || status === "waiting_agent";

// ---- 記録主体。Humanの発言と、Agentの発言・要約を区別して出す。 ----

const agentRoleLabels: Record<string, string> = {
  manager: "Manager", worker: "Worker", reviewer: "Reviewer", strategist: "Strategist", researcher: "Researcher", evaluator: "Evaluator",
};

/** 記録主体の表示。HumanはMemberの表示名、AgentはPrincipalとRole。 */
export const describeActor = (actor: ConsultationActor, humanNames?: ReadonlyMap<string, string>): string =>
  actor.kind === "human" ? describePrincipal(actor.principalId, humanNames) : `Agent ${actor.principalId}（${agentRoleLabels[actor.role] ?? actor.role}）`;

/** 発言の種類の表示。Agentの発言はHumanの判断待ちへ戻す回答・追加質問。 */
export const messageKindLabel = (message: Pick<ConsultationMessage, "author" | "correctsMessageId">): string =>
  `${message.author.kind === "human" ? "Humanの返信" : "Agentの回答・質問"}${message.correctsMessageId ? "（訂正）" : ""}`;

/** 結論の根拠にした発言の番号（会話の順序）。会話に無いIDは出さない。 */
export const basisSequences = (resolution: Pick<ConsultationResolution, "basisMessageIds">, messages: readonly Pick<ConsultationMessage, "id" | "sequence">[]): number[] =>
  resolution.basisMessageIds.flatMap((id) => messages.find((message) => message.id === id)?.sequence ?? []);

/** 発言のanchor（訂正・根拠から辿る）。 */
export const messageAnchorId = (messageId: string) => `consultation-message-${messageId}`;

// ---- 参照。成果物は正本へのlinkだけを出し、Web UI内のTask・Story・Intent・Outcome・相談は対応する画面へ辿る。 ----
// 参照先は相談と同じscopeのもの（serverが作成時に検証する）で、相談を閲覧できるHumanはその参照先も閲覧できる。

export type ConsultationResourceLink = { id: string; name: string; url: string };
export type ConsultationReferenceView = { label: string; detail: string | null; href?: string; to?: string };

export const describeConsultationReference = (
  scope: ConsultationScope,
  reference: ConsultationReference,
  resources: readonly ConsultationResourceLink[] | null,
): ConsultationReferenceView => {
  if (reference.kind === "url") return { label: reference.url, detail: null, href: reference.url };
  if (reference.kind === "consultation") return { label: `相談 ${reference.id.slice(0, 8)}`, detail: null, to: consultationDetailPath(scope, reference.id) };
  if (scope.kind === "workspace") {
    if (reference.kind === "intent") return { label: `Intent ${reference.id.slice(0, 8)}`, detail: null, to: workspacePath(scope.workspaceId, "direction") };
    if (reference.kind === "outcome") return { label: `Outcome ${reference.id.slice(0, 8)}`, detail: null, to: workspaceOutcomePath(scope.workspaceId, reference.intentId, reference.id) };
    return { label: `${reference.kind} ${"id" in reference ? reference.id.slice(0, 8) : ""}`.trim(), detail: null };
  }
  const { projectId } = scope;
  if (reference.kind === "project_resource") {
    const resource = resources?.find((item) => item.id === reference.resourceId);
    const detail = [reference.path, reference.revision && `@ ${reference.revision.slice(0, 12)}`].filter(Boolean).join(" ") || null;
    if (resource) return { label: resource.name, detail, href: resource.url };
    return { label: resources ? `登録が外れたResource ${reference.resourceId}` : `Resource ${reference.resourceId}`, detail };
  }
  if (reference.kind === "task") return { label: `Task ${reference.id.slice(0, 8)}`, detail: null, to: taskPath(projectId, reference.id) };
  if (reference.kind === "story") return { label: `Story ${reference.id.slice(0, 8)}`, detail: null, to: projectViewPath(projectId, "work", storyAnchorId(reference.id)) };
  return { label: `${reference.kind} ${reference.id.slice(0, 8)}`, detail: null };
};

// ---- 横断した判断待ち（`/consultations`）。絞り込みはURLのqueryで表し、再読込・共有・戻るで同じ一覧へ戻る。 ----

export const inboxScopeFilters = ["all", "project", "workspace"] as const;
export type InboxScopeFilter = (typeof inboxScopeFilters)[number];
export const inboxScopeFilterLabels: Record<InboxScopeFilter, string> = { all: "すべて", project: "Project", workspace: "Workspace" };

/** 横断一覧の絞り込み。Projectを選ぶとそのProjectの相談だけ（Workspace相談を含まない）。 */
export type InboxQuery = { status: ConsultationFilter; scope: InboxScopeFilter; projectId: string | null; workspaceId: string | null };

export const parseInboxQuery = (params: URLSearchParams): InboxQuery => {
  const scope = inboxScopeFilters.find((value) => value === params.get("scope")) ?? "all";
  const projectId = params.get("projectId") || null;
  return {
    status: parseConsultationFilter(params.get("status")),
    // Projectの指定はProject scopeだけを対象にするため、Workspaceのscopeとは組み合わせない。
    scope: projectId !== null && scope === "workspace" ? "project" : scope,
    projectId,
    workspaceId: params.get("workspaceId") || null,
  };
};

/** 絞り込みを変えた画面のquery。既定値（Humanの判断待ち・すべてのscope・指定なし）はqueryを付けない。 */
export const inboxSearch = (query: InboxQuery): string => {
  const params = new URLSearchParams();
  if (query.status !== "waiting_human") params.set("status", query.status);
  if (query.scope !== "all") params.set("scope", query.scope);
  if (query.workspaceId) params.set("workspaceId", query.workspaceId);
  if (query.projectId) params.set("projectId", query.projectId);
  const search = params.toString();
  return search ? `?${search}` : "";
};

export const inboxPath = (query: InboxQuery) => `${consultationInboxPath}${inboxSearch(query)}`;

/** `GET /api/consultations`のpath。`cursor`は前の応答の`nextCursor`。 */
export const inboxApiPath = (query: InboxQuery, cursor?: string | null) => {
  const params = new URLSearchParams({ status: query.status });
  if (query.scope !== "all") params.set("scope", query.scope);
  if (query.workspaceId) params.set("workspaceId", query.workspaceId);
  if (query.projectId) params.set("projectId", query.projectId);
  if (cursor) params.set("cursor", cursor);
  return `/api/consultations?${params.toString()}`;
};

/** `GET /api/consultations`の応答。`nextCursor`は続きがあるときだけ。 */
export type InboxPage = { consultations: Consultation[]; nextCursor: string | null };

/** 一覧の行に出す所属。名前は閲覧できるProject・Workspaceの一覧から引き、無ければIDの先頭を出す。 */
export const describeConsultationScope = (
  consultation: Pick<Consultation, "scope" | "workspaceId" | "projectId">,
  names: { projects: ReadonlyMap<string, string>; workspaces: ReadonlyMap<string, string> },
): string => {
  const scope = scopeOfConsultation(consultation);
  const id = scope.kind === "project" ? scope.projectId : scope.workspaceId;
  const name = (scope.kind === "project" ? names.projects : names.workspaces).get(id) ?? id.slice(0, 8);
  return `${consultationScopeLabels[scope.kind]} · ${name}`;
};

// ---- 再送の冪等性。同じ入力の再試行は同じ`requestId`で送り、入力を変えたら新しい`requestId`にする。 ----

export const newRequestId = (): string => globalThis.crypto.randomUUID();
