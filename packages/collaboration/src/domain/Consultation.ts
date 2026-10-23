/**
 * 相談（Consultation）。Agentが解決できない設計・要件の問題をHumanへ問い、会話（Message）と結論（Resolution）を分けて残す。
 * 状態は`waiting_human`（Humanの判断待ち）→ Human返信で`waiting_agent` → Agentの追加質問で`waiting_human`、または結論で`resolved`。
 * 不要になった相談は理由付きで`canceled`にする。解決・取消後の方針変更は、元の相談を`supersedesConsultationId`で参照する新しい相談とする。
 * Webの画面からも読むため、外部技術・他moduleに依存しない型と純関数だけを置く。
 */

export const consultationStatuses = ["waiting_human", "waiting_agent", "resolved", "canceled"] as const;
export type ConsultationStatus = (typeof consultationStatuses)[number];

/** 会話・結論を記録した主体の種類。Humanの発言とAgentの発言・要約を区別する。 */
export type ConsultationActorKind = "human" | "agent";

/**
 * 記録主体。`principalId`はHumanなら`human:{humanUserId}`、AgentならBearerから解決したPrincipal。入力からは受け取らない。
 * `role`はAgentならProject Execution Role（manager / worker / reviewer）、Humanなら`operator`。
 */
export type ConsultationActor = { kind: ConsultationActorKind; principalId: string; role: string };

/** Humanへ示す選択肢。順序（0始まりのindex）で結論の`selectedOption`から指す。 */
export type ConsultationOption = { label: string; description: string | null };

/** 相談の根拠・関連先。本文は複製せず、所在だけを持つ。 */
export type ConsultationReference =
  | { kind: "url"; url: string }
  | { kind: "project_resource"; resourceId: string; path: string | null; revision: string | null }
  | { kind: "task" | "story" | "consultation"; id: string };

export type ConsultationCancellation = { reason: string; by: ConsultationActor; at: number };

export type Consultation = {
  id: string;
  workspaceId: string;
  projectId: string;
  title: string;
  /** 判断したいこと（Humanへの質問）。 */
  question: string;
  /** これが決まらないと進めない理由。 */
  blockingReason: string;
  options: ConsultationOption[];
  /** 起票したAgentの推奨。 */
  recommendation: string;
  /** 判断が及ぼす影響。 */
  impact: string;
  refs: ConsultationReference[];
  status: ConsultationStatus;
  /** 会話・結論・取消のたびに1つ進む版。古い版を見た更新（`expectedRevision`）と応答leaseの入力版の照合に使う。 */
  revision: number;
  /** 方針の変更・訂正で、元にした解決済み・取消済みの相談。 */
  supersedesConsultationId: string | null;
  createdBy: ConsultationActor;
  createdAt: number;
  updatedAt: number;
  cancellation: ConsultationCancellation | null;
};

/** 会話の1発言。追記だけで、書き換えない。訂正は`correctsMessageId`で自分の発言を指す新しい発言とする。 */
export type ConsultationMessage = {
  id: string;
  consultationId: string;
  /** 相談内の順序（1始まり）。 */
  sequence: number;
  author: ConsultationActor;
  body: string;
  correctsMessageId: string | null;
  /** この発言で進んだ相談の版。 */
  revision: number;
  createdAt: number;
};

/**
 * 判断の由来。`human_decision`はHumanがWeb UIで明示した決定、`agent_summary`はManagerがHumanの返信を根拠に整理した結論。
 * 由来は入口（Human向けWeb API・Agent向けMCP）で決まり、入力では指定させない（AgentがHumanの明示決定を記録できない）。
 */
export type ResolutionSource = "human_decision" | "agent_summary";

export type ConsultationResolution = {
  id: string;
  consultationId: string;
  source: ResolutionSource;
  conclusion: string;
  rationale: string;
  /** 結論の適用範囲。 */
  applicability: string | null;
  /** 採用した選択肢のindex。選択肢に依らない結論はnull。 */
  selectedOption: number | null;
  /** 結論の根拠にした発言。`agent_summary`はHumanの発言を1つ以上含む。 */
  basisMessageIds: string[];
  /** 結論の根拠にした会話の版。 */
  basisRevision: number;
  recordedBy: ConsultationActor;
  createdAt: number;
};

/**
 * Agentの応答の実行権。相談IDと入力版（Humanの返信で進んだ版）ごとの短いleaseで、同じ返信への多重回答・二重解決を防ぐ。
 * TaskのClaimとは別のもの。期限切れ・解放済み・版の古いleaseは無効とし、状態を書き換えずに判定する。
 */
export type ConsultationLease = {
  id: string;
  consultationId: string;
  inputRevision: number;
  principalId: string;
  role: string;
  acquiredAt: number;
  expiresAt: number;
  releasedAt: number | null;
};

export const consultationLeaseTtlMs = 5 * 60 * 1000;

/** 業務規則の違反。入口は`CONFLICT`とし、`conflict`へこのcodeを入れる。 */
export type ConsultationViolation =
  | "CONSULTATION_CLOSED"
  | "NOT_WAITING_AGENT"
  | "STALE_REVISION"
  | "LEASE_HELD"
  | "LEASE_NOT_HELD"
  | "LEASE_EXPIRED"
  | "SUPERSEDED_NOT_CLOSED";

export const isConsultationOpen = (status: ConsultationStatus): boolean => status === "waiting_human" || status === "waiting_agent";

/** 発言後の状態。Humanの返信はAgentの応答待ち、Agentの回答・追加質問はHumanの判断待ちにする。 */
export const statusAfterMessage = (author: ConsultationActorKind): ConsultationStatus =>
  author === "human" ? "waiting_agent" : "waiting_human";

/** leaseが現在の版に対して有効か（未解放・期限内・入力版が現在の版）。 */
export const isLeaseActive = (lease: ConsultationLease, consultation: Pick<Consultation, "revision">, now: number): boolean =>
  lease.releasedAt === null && now < lease.expiresAt && lease.inputRevision === consultation.revision;

/** Humanの返信。未解決の相談にだけ追記できる（解決・取消後は新しい相談にする）。 */
export const checkHumanMessage = (consultation: Pick<Consultation, "status">): ConsultationViolation | null =>
  isConsultationOpen(consultation.status) ? null : "CONSULTATION_CLOSED";

/** Humanの明示決定・取消。閲覧した版が現在の版でなければ拒否し、最新の会話を読ませる。 */
export const checkHumanClosing = (consultation: Pick<Consultation, "status" | "revision">, expectedRevision: number): ConsultationViolation | null => {
  if (!isConsultationOpen(consultation.status)) return "CONSULTATION_CLOSED";
  return expectedRevision === consultation.revision ? null : "STALE_REVISION";
};

/** Agentの応答leaseの取得。Humanの新しい入力（`waiting_agent`）の現在の版に対し、他のPrincipalの有効なleaseが無いこと。 */
export const checkLeaseAcquisition = (
  consultation: Pick<Consultation, "status" | "revision">,
  inputRevision: number,
  activeLease: ConsultationLease | null,
  principalId: string,
): ConsultationViolation | null => {
  if (!isConsultationOpen(consultation.status)) return "CONSULTATION_CLOSED";
  if (consultation.status !== "waiting_agent") return "NOT_WAITING_AGENT";
  if (inputRevision !== consultation.revision) return "STALE_REVISION";
  if (activeLease && activeLease.principalId !== principalId) return "LEASE_HELD";
  return null;
};

/**
 * Agentの回答・追加質問・結論整理。`waiting_agent`の現在の版を見ており、その版の自分のleaseを期限内に持つこと。
 * Humanが応答中に追加で返信した場合は版が進むため、古い版の応答・解決を拒否する。
 */
export const checkAgentResponse = (
  consultation: Pick<Consultation, "status" | "revision">,
  expectedRevision: number,
  lease: ConsultationLease | null,
  principalId: string,
  now: number,
): ConsultationViolation | null => {
  if (!isConsultationOpen(consultation.status)) return "CONSULTATION_CLOSED";
  if (consultation.status !== "waiting_agent") return "NOT_WAITING_AGENT";
  if (expectedRevision !== consultation.revision) return "STALE_REVISION";
  if (!lease || lease.principalId !== principalId || lease.releasedAt !== null) return "LEASE_NOT_HELD";
  if (now >= lease.expiresAt) return "LEASE_EXPIRED";
  if (lease.inputRevision !== consultation.revision) return "STALE_REVISION";
  return null;
};

/** Agentの取消。版の照合だけで、leaseは要求しない（Humanの返信待ちでも不要になった相談を閉じられる）。 */
export const checkAgentCancel = checkHumanClosing;

/** 方針変更の新しい相談が参照できるのは、解決済み・取消済みの相談だけ（未解決の相談は同じ相談で会話を続ける）。 */
export const checkSupersedes = (superseded: Pick<Consultation, "status">): ConsultationViolation | null =>
  isConsultationOpen(superseded.status) ? "SUPERSEDED_NOT_CLOSED" : null;

/** Agentの結論整理の根拠に、Humanの発言が含まれるか。Humanの判断を経ない結論をAgentだけで確定させない。 */
export const hasHumanBasis = (basis: readonly Pick<ConsultationMessage, "author">[]): boolean =>
  basis.some((message) => message.author.kind === "human");
