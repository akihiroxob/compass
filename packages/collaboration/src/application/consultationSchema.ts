import { fullCommitSha, httpUrl, optionalText, parseWith, repositoryRelativePath, trimmedText } from "@compass/shared";
import { z } from "zod";
import { consultationScopeKinds, consultationStatuses, followupKinds, type ConsultationReference } from "../domain/Consultation.ts";

export const maximumConsultationOptions = 10;
export const maximumConsultationRefs = 20;
export const maximumConsultationMessageLength = 20_000;
export const maximumBasisMessages = 50;

const identifier = (label: string) => trimmedText(label, 200);
const longText = (label: string) => trimmedText(label, 5_000);

const absoluteUrl = z
  .string()
  .trim()
  .max(2_000, "url must be 2000 characters or fewer")
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL");

const referenceSchema = z.union([
  z.object({ kind: z.literal("url"), url: absoluteUrl }).strict(),
  z
    .object({
      kind: z.literal("project_resource"),
      resourceId: identifier("resourceId"),
      path: optionalText(1_000),
      revision: optionalText(200),
    })
    .strict(),
  z.object({ kind: z.enum(["task", "story", "intent", "consultation"]), id: identifier("id") }).strict(),
  z.object({ kind: z.literal("outcome"), intentId: identifier("intentId"), id: identifier("id") }).strict(),
]);

const optionSchema = z.object({ label: trimmedText("label", 200), description: optionalText(2_000) }).strict();

/** 回答期限。時刻帯（`Z`または`+09:00`等）付きのISO 8601で受け取り、epoch msにする。 */
const dueAtSchema = z
  .string()
  .trim()
  .max(40, "dueAt must be an ISO 8601 date-time with a time zone")
  .refine((value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/.test(value) && !Number.isNaN(Date.parse(value)), "dueAt must be an ISO 8601 date-time with a time zone")
  .transform((value) => Date.parse(value));

const requestId = identifier("requestId");
const revision = (label: string) => z.number({ error: `${label} is required` }).int().min(1);

/**
 * 相談の作成（Agent）。判断したいこと・進めない理由・推奨・影響を必須にし、意味の妥当性はServerで判定しない。
 * Principal・Roleの来歴は入力に持たない（Bearerと認可したRoleから決める）。
 */
const createConsultationSchema = z
  .object({
    title: trimmedText("title", 200),
    question: longText("question"),
    blockingReason: longText("blockingReason"),
    options: z.array(optionSchema).max(maximumConsultationOptions, `options must be ${maximumConsultationOptions} items or fewer`).default([]),
    recommendation: longText("recommendation"),
    impact: longText("impact"),
    dueAt: dueAtSchema.optional(),
    refs: z.array(referenceSchema).max(maximumConsultationRefs, `refs must be ${maximumConsultationRefs} items or fewer`).default([]),
    supersedesConsultationId: identifier("supersedesConsultationId").optional(),
    requestId,
  })
  .strict();

export type CreateConsultationInput = Omit<z.output<typeof createConsultationSchema>, "refs"> & { refs: ConsultationReference[] };

export const parseCreateConsultationInput = (input: unknown): CreateConsultationInput =>
  parseWith(createConsultationSchema, input, "Consultation") as CreateConsultationInput;

const messageFields = {
  body: trimmedText("body", maximumConsultationMessageLength),
  correctsMessageId: identifier("correctsMessageId").optional(),
  requestId,
};

/** Humanの返信。版の照合はしない（Humanはいつでも追記でき、追記はAgentの応答中の版を進める）。 */
const humanMessageSchema = z.object(messageFields).strict();

/** Agentの回答・追加質問。現在の版と、その版の自分の応答leaseを要求する。 */
const agentMessageSchema = z
  .object({ ...messageFields, leaseId: identifier("leaseId"), expectedRevision: revision("expectedRevision") })
  .strict();

export type HumanMessageInput = z.output<typeof humanMessageSchema>;
export type AgentMessageInput = z.output<typeof agentMessageSchema>;

export const parseHumanMessageInput = (input: unknown): HumanMessageInput => parseWith(humanMessageSchema, input, "Consultation message");
export const parseAgentMessageInput = (input: unknown): AgentMessageInput => parseWith(agentMessageSchema, input, "Consultation message");

const resolutionFields = {
  conclusion: longText("conclusion"),
  rationale: trimmedText("rationale", 10_000),
  applicability: optionalText(2_000),
  selectedOption: z.number().int().min(0).nullable().optional(),
  expectedRevision: revision("expectedRevision"),
  requestId,
};

const basisMessageIds = z.array(identifier("basisMessageIds")).max(maximumBasisMessages, `basisMessageIds must be ${maximumBasisMessages} items or fewer`);

/** Humanの明示決定。決定そのものがHumanの判断のため、根拠の発言は任意。 */
const humanDecisionSchema = z.object({ ...resolutionFields, basisMessageIds: basisMessageIds.default([]) }).strict();

/** 応答Role（Manager・Strategist）の結論整理。Humanの発言を含む根拠の発言と、応答leaseを要求する。 */
const agentResolutionSchema = z
  .object({ ...resolutionFields, basisMessageIds: basisMessageIds.min(1, "basisMessageIds must include the Human messages the conclusion is based on"), leaseId: identifier("leaseId") })
  .strict();

export type HumanDecisionInput = z.output<typeof humanDecisionSchema>;
export type AgentResolutionInput = z.output<typeof agentResolutionSchema>;

export const parseHumanDecisionInput = (input: unknown): HumanDecisionInput => parseWith(humanDecisionSchema, input, "Consultation resolution");
export const parseAgentResolutionInput = (input: unknown): AgentResolutionInput => parseWith(agentResolutionSchema, input, "Consultation resolution");

const cancelSchema = z.object({ reason: trimmedText("reason", 2_000), expectedRevision: revision("expectedRevision"), requestId }).strict();
export type CancelConsultationInput = z.output<typeof cancelSchema>;
export const parseCancelConsultationInput = (input: unknown): CancelConsultationInput => parseWith(cancelSchema, input, "Consultation cancel");

const leaseSchema = z.object({ inputRevision: revision("inputRevision"), requestId }).strict();
export type AcquireLeaseInput = z.output<typeof leaseSchema>;
export const parseAcquireLeaseInput = (input: unknown): AcquireLeaseInput => parseWith(leaseSchema, input, "Consultation lease");

const listQuerySchema = z.object({ status: z.enum(consultationStatuses).optional() }).strict();
export type ConsultationListQuery = z.input<typeof listQuerySchema>;
export const parseConsultationListQuery = (input: unknown) => parseWith(listQuerySchema, input ?? {}, "Consultation query");

export const defaultAccessibleConsultationLimit = 30;
export const maximumAccessibleConsultationLimit = 100;

/** 期限が未設定の相談の並び位置（期限のある相談より後ろ）。epoch msより大きい値。 */
export const unknownDueKey = Number.MAX_SAFE_INTEGER;

/** 横断一覧の並び。`updated`は更新の新しい順、`due`は期限が近い順（期限未設定は後ろで更新の新しい順）。 */
export const accessibleConsultationSorts = ["updated", "due"] as const;
export type AccessibleConsultationSort = (typeof accessibleConsultationSorts)[number];

/** 横断一覧の位置。`updated`は`<updatedAt>.<id>`、`due`は`<dueKey>.<updatedAt>.<id>`（応答の`nextCursor`をそのまま渡す）。 */
export type AccessibleConsultationCursor = { dueKey?: number; updatedAt: number; id: string };

const decodeCursor = (value: string, sort: AccessibleConsultationSort): AccessibleConsultationCursor | null => {
  if (sort === "due") {
    const match = /^(\d{1,16})\.(\d{1,16})\.(.+)$/.exec(value);
    return match ? { dueKey: Number(match[1]), updatedAt: Number(match[2]), id: match[3]! } : null;
  }
  const match = /^(\d{1,16})\.(.+)$/.exec(value);
  return match ? { updatedAt: Number(match[1]), id: match[2]! } : null;
};

/**
 * 横断一覧（Humanの判断待ち）のquery。状態の既定はHumanの判断待ち（`waiting_human`）で、`all`は全状態。scope・Project・Workspaceで絞る。
 * 値はWeb APIのquery文字列のため、`limit`は数字の文字列も受け付ける。
 */
const accessibleListQuerySchema = z
  .object({
    status: z.enum([...consultationStatuses, "all"]).default("waiting_human"),
    scope: z.enum(consultationScopeKinds).optional(),
    projectId: identifier("projectId").optional(),
    workspaceId: identifier("workspaceId").optional(),
    sort: z.enum(accessibleConsultationSorts).default("updated"),
    limit: z.coerce.number().int().min(1).max(maximumAccessibleConsultationLimit).default(defaultAccessibleConsultationLimit),
    cursor: z.string().trim().max(300, "cursor is invalid").optional(),
  })
  .strict()
  .transform(({ cursor, ...rest }, context) => {
    const decoded = cursor === undefined ? undefined : decodeCursor(cursor, rest.sort);
    if (cursor !== undefined && !decoded) {
      context.addIssue({ code: "custom", path: ["cursor"], message: "cursor is invalid" });
      return z.NEVER;
    }
    return { ...rest, cursor: decoded as AccessibleConsultationCursor | undefined };
  });
export type AccessibleConsultationListQuery = z.output<typeof accessibleListQuerySchema>;
export const parseAccessibleConsultationListQuery = (input: unknown): AccessibleConsultationListQuery =>
  parseWith(accessibleListQuerySchema, input ?? {}, "Consultation query");

/**
 * 結論からの文書反映の依頼（Projectの応答Role）。反映先の種類・Repositoryと、Workerへ渡す目的・決定内容・根拠・検証方法を必須にする。
 * 種類の判断・文書内容の整理はAgentが行い、Serverは意味を判定しない。`resumptionDependency`は元Taskの再開をこの反映の後にする理由で、
 * 指定したときだけ待機条件になる。
 */
const followupRequestSchema = z
  .object({
    kind: z.enum(followupKinds, { error: `kind must be one of: ${followupKinds.join(", ")}` }),
    repositoryId: identifier("repositoryId"),
    storyId: identifier("storyId").optional(),
    title: trimmedText("title", 200),
    purpose: longText("purpose"),
    decision: trimmedText("decision", 10_000),
    rationale: longText("rationale"),
    verification: longText("verification"),
    resumptionDependency: optionalText(2_000),
    requestId,
  })
  .strict();
export type FollowupRequestInput = z.output<typeof followupRequestSchema>;
export const parseFollowupRequestInput = (input: unknown): FollowupRequestInput => parseWith(followupRequestSchema, input, "Consultation follow-up");

/**
 * 受入済みの文書反映Taskの成果物参照。Task・Repositoryを明示させて依頼との一致を検査し、無関係なTask・Repositoryの参照だけで反映済みにしない。
 * path・commit SHA・PR URLの形式はDirectionのADR参照と同じ検査を使う。
 */
const artifactSchema = z
  .object({
    followupId: identifier("followupId"),
    taskId: identifier("taskId"),
    repositoryId: identifier("repositoryId"),
    path: repositoryRelativePath,
    commitSha: fullCommitSha.transform((value) => value.toLowerCase()),
    pullRequestUrl: httpUrl("pullRequestUrl").nullable().optional().transform((value) => value ?? null),
    requestId,
  })
  .strict();
export type ArtifactInput = z.output<typeof artifactSchema>;
export const parseArtifactInput = (input: unknown): ArtifactInput => parseWith(artifactSchema, input, "Consultation artifact");

/** Workspace相談の結論の引継ぎ先（Workspaceに所属するProject）。 */
const handoffSchema = z.object({ projectId: identifier("projectId"), requestId }).strict();
export type HandoffInput = z.output<typeof handoffSchema>;
export const parseHandoffInput = (input: unknown): HandoffInput => parseWith(handoffSchema, input, "Consultation handoff");
