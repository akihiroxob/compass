// Project相談（判断待ち）の型・Web API path・表示の判定。表示から分けた純関数で、導線の表示だけを決める（拒否は常にserverが行う）。
// テストからも読み込むため、純関数のmodule以外をimportしない。
import type {
  Consultation,
  ConsultationActor,
  ConsultationMessage,
  ConsultationReference,
  ConsultationResolution,
  ConsultationStatus,
  ResolutionSource,
} from "@compass/collaboration/domain";
import { consultationPath, projectViewPath, taskPath } from "../../paths.ts";
import type { StatusTone } from "../../statusTone.ts";
import { describePrincipal, storyAnchorId } from "../execution/model.ts";

export type { Consultation, ConsultationActor, ConsultationMessage, ConsultationReference, ConsultationResolution, ConsultationStatus };

/** 現在応答中のAgent（有効な応答lease）。 */
export type ConsultationResponder = { principalId: string; role: string; inputRevision: number; expiresAt: number };

/** `GET /api/projects/:projectId/consultations/:consultationId`の応答。 */
export type ConsultationDetail = {
  consultation: Consultation;
  messages: ConsultationMessage[];
  resolution: ConsultationResolution | null;
  responder: ConsultationResponder | null;
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

// ---- 一覧の絞り込み。Project詳細の「判断待ち」viewで`?status=`に表す。既定はHumanの判断待ち。 ----

export const consultationFilters = ["waiting_human", "waiting_agent", "resolved", "canceled", "all"] as const;
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

/** 一覧画面（Project詳細の「判断待ち」view）。 */
export const consultationListPath = (projectId: string) => projectViewPath(projectId, "consultations");

export const consultationsApiPath = (projectId: string, filter: ConsultationFilter = "all") =>
  `/api/projects/${projectId}/consultations${filter === "all" ? "" : `?status=${filter}`}`;

export const consultationApiPath = (projectId: string, consultationId: string, suffix: "" | "/messages" | "/resolution" | "/cancel" = "") =>
  `/api/projects/${projectId}/consultations/${consultationId}${suffix}`;

export const isOpenConsultation = (status: ConsultationStatus) => status === "waiting_human" || status === "waiting_agent";

// ---- 記録主体。Humanの発言と、Agentの発言・要約を区別して出す。 ----

const agentRoleLabels: Record<string, string> = { manager: "Manager", worker: "Worker", reviewer: "Reviewer" };

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

// ---- 参照。成果物は正本へのlinkだけを出し、Web UI内のTask・Story・相談は対応する画面へ辿る。 ----

export type ConsultationResourceLink = { id: string; name: string; url: string };
export type ConsultationReferenceView = { label: string; detail: string | null; href?: string; to?: string };

export const describeConsultationReference = (
  projectId: string,
  reference: ConsultationReference,
  resources: readonly ConsultationResourceLink[] | null,
): ConsultationReferenceView => {
  if (reference.kind === "url") return { label: reference.url, detail: null, href: reference.url };
  if (reference.kind === "project_resource") {
    const resource = resources?.find((item) => item.id === reference.resourceId);
    const detail = [reference.path, reference.revision && `@ ${reference.revision.slice(0, 12)}`].filter(Boolean).join(" ") || null;
    if (resource) return { label: resource.name, detail, href: resource.url };
    return { label: resources ? `登録が外れたResource ${reference.resourceId}` : `Resource ${reference.resourceId}`, detail };
  }
  if (reference.kind === "task") return { label: `Task ${reference.id.slice(0, 8)}`, detail: null, to: taskPath(projectId, reference.id) };
  if (reference.kind === "story") return { label: `Story ${reference.id.slice(0, 8)}`, detail: null, to: projectViewPath(projectId, "work", storyAnchorId(reference.id)) };
  return { label: `相談 ${reference.id.slice(0, 8)}`, detail: null, to: consultationPath(projectId, reference.id) };
};

// ---- 再送の冪等性。同じ入力の再試行は同じ`requestId`で送り、入力を変えたら新しい`requestId`にする。 ----

export const newRequestId = (): string => globalThis.crypto.randomUUID();
