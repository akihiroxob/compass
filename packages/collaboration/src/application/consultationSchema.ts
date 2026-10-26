import { optionalText, parseWith, trimmedText } from "@compass/shared";
import { z } from "zod";
import { consultationScopeKinds, consultationStatuses, type ConsultationReference } from "../domain/Consultation.ts";

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

/** 横断一覧の位置。`<updatedAt>.<id>`（応答の`nextCursor`をそのまま渡す）。 */
const cursorSchema = z
  .string()
  .trim()
  .max(300, "cursor is invalid")
  .transform((value, context) => {
    const match = /^(\d{1,16})\.(.+)$/.exec(value);
    if (!match) {
      context.addIssue({ code: "custom", message: "cursor is invalid" });
      return z.NEVER;
    }
    return { updatedAt: Number(match[1]), id: match[2]! };
  });

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
    limit: z.coerce.number().int().min(1).max(maximumAccessibleConsultationLimit).default(defaultAccessibleConsultationLimit),
    cursor: cursorSchema.optional(),
  })
  .strict();
export type AccessibleConsultationListQuery = z.output<typeof accessibleListQuerySchema>;
export const parseAccessibleConsultationListQuery = (input: unknown): AccessibleConsultationListQuery =>
  parseWith(accessibleListQuerySchema, input ?? {}, "Consultation query");
