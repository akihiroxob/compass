import { z } from "zod";
import {
  evidenceKinds,
  researchConclusions,
  researchConfidences,
} from "../domain/model/Research.ts";
import { parseWith, trimmedText } from "./projectSchema.ts";

/** 予算の上限。単位はRuntimeが定める抽象量で、Compassは総量と使用量の整合だけを検証する。 */
const maximumBudget = 10_000;

const epochMillis = z.number().int().positive("must be a positive epoch milliseconds value");

const idText = z.string().trim().min(1, "id must not be empty").max(200);

const optionalId = idText.nullish().transform((value) => value ?? null);

const optionalEpochMillis = epochMillis.nullish().transform((value) => value ?? null);

const textList = (label: string, maximum: number, maximumItems: number) =>
  z.array(trimmedText(label, maximum)).max(maximumItems).default([]);

const webUrl = z
  .url("must be a valid URL")
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "must use http or https",
  });

/** transportの再送を同じ操作として扱うためのkey。同じkeyで異なる内容を送った場合は競合になる。 */
const requestKey = trimmedText("requestKey", 200);

const provenance = {
  principalId: trimmedText("principalId", 200),
  runRef: trimmedText("runRef", 500),
};

/**
 * Research Requestの調査計画（Question・範囲・完了条件・予算・期限）。Strategistの追加Research判断でも同じ規則を使う。
 * 期限が未来かどうかは時刻源を持つ永続化側で検査する。
 */
export const researchPlanShape = {
  question: trimmedText("question", 2_000),
  scope: trimmedText("scope", 2_000),
  completionCondition: trimmedText("completionCondition", 2_000),
  budgetTotal: z.number().int().min(1).max(maximumBudget),
  deadlineAt: optionalEpochMillis,
};

export const createResearchRequestSchema = z
  .object({
    requestKey,
    kind: z.enum(["project_watch", "decision"]).default("decision"),
    originIntentId: optionalId,
    originOutcomeId: optionalId,
    ...researchPlanShape,
    correlationId: trimmedText("correlationId", 200).optional(),
  })
  .superRefine((input, context) => {
    if (input.kind === "decision" && input.originIntentId === null) {
      context.addIssue({
        code: "custom",
        message: "originIntentId is required for a decision request",
        path: ["originIntentId"],
      });
    }
    if (input.kind === "project_watch" && (input.originIntentId !== null || input.originOutcomeId !== null)) {
      context.addIssue({
        code: "custom",
        message: "a project_watch request must not have an origin Intent or Outcome",
        path: [input.originIntentId !== null ? "originIntentId" : "originOutcomeId"],
      });
    }
    if (input.originOutcomeId !== null && input.originIntentId === null) {
      context.addIssue({
        code: "custom",
        message: "originOutcomeId requires originIntentId",
        path: ["originOutcomeId"],
      });
    }
  });

export type CreateResearchRequestInput = z.infer<typeof createResearchRequestSchema>;

const evidenceReferenceSchema = z
  .object({
    kind: z.enum(evidenceKinds),
    uri: trimmedText("uri", 2_000),
    retrievedAt: epochMillis,
    versionHash: trimmedText("versionHash", 200).nullish().transform((value) => value ?? null),
  })
  .superRefine((input, context) => {
    // repository_file / wacha_run は外部URLではなく、Repository内path・Run参照を書く。
    if (["url", "issue", "pull_request", "ci"].includes(input.kind) && !webUrl.safeParse(input.uri).success) {
      context.addIssue({ code: "custom", message: "uri must be an http or https URL", path: ["uri"] });
    }
  });

const findingInputSchema = z
  .object({
    statement: trimmedText("statement", 2_000),
    confidence: z.enum(researchConfidences),
    observedAt: epochMillis,
    expiresAt: optionalEpochMillis,
    /** 同じResultの`evidenceRefs`の位置。Evidenceを持たないFindingは登録できない。 */
    evidenceIndexes: z.array(z.number().int().min(0)).min(1, "at least one evidence is required").max(20),
    conflictsWithFindingIds: z.array(idText).max(20).default([]),
  })
  .superRefine((input, context) => {
    if (input.expiresAt !== null && input.expiresAt <= input.observedAt) {
      context.addIssue({ code: "custom", message: "expiresAt must be after observedAt", path: ["expiresAt"] });
    }
    if (new Set(input.evidenceIndexes).size !== input.evidenceIndexes.length) {
      context.addIssue({ code: "custom", message: "evidenceIndexes must be unique", path: ["evidenceIndexes"] });
    }
    if (new Set(input.conflictsWithFindingIds).size !== input.conflictsWithFindingIds.length) {
      context.addIssue({
        code: "custom",
        message: "conflictsWithFindingIds must be unique",
        path: ["conflictsWithFindingIds"],
      });
    }
  });

export const registerResearchResultSchema = z
  .object({
    requestKey,
    ...provenance,
    summary: trimmedText("summary", 4_000),
    budgetUsed: z.number().int().min(0).max(maximumBudget).default(0),
    evidenceRefs: z.array(evidenceReferenceSchema).max(50).default([]),
    findings: z.array(findingInputSchema).max(50).default([]),
    unknowns: textList("unknown", 1_000, 20),
    options: textList("option", 1_000, 20),
    risks: textList("risk", 1_000, 20),
  })
  .superRefine((input, context) => {
    input.findings.forEach((finding, index) => {
      finding.evidenceIndexes.forEach((evidenceIndex, position) => {
        if (evidenceIndex >= input.evidenceRefs.length) {
          context.addIssue({
            code: "custom",
            message: "evidenceIndexes must point to an entry of evidenceRefs",
            path: ["findings", index, "evidenceIndexes", position],
          });
        }
      });
    });
  });

export type RegisterResearchResultInput = z.infer<typeof registerResearchResultSchema>;

export const registerResearchSynthesisSchema = z
  .object({
    requestKey,
    ...provenance,
    conclusion: trimmedText("conclusion", 4_000),
    findingIds: z.array(idText).min(1, "at least one finding is required").max(100),
    risks: textList("risk", 1_000, 20),
    options: textList("option", 1_000, 20),
    unknowns: textList("unknown", 1_000, 20),
    validAsOf: epochMillis,
    supersedesId: optionalId,
  })
  .superRefine((input, context) => {
    if (new Set(input.findingIds).size !== input.findingIds.length) {
      context.addIssue({ code: "custom", message: "findingIds must be unique", path: ["findingIds"] });
    }
  });

export type RegisterResearchSynthesisInput = z.infer<typeof registerResearchSynthesisSchema>;

/** insufficient / not_needed は、Runtimeが次の判断へ進めるための根拠として停止理由を必須にする。 */
export const completeResearchRequestSchema = z
  .object({
    conclusion: z.enum(researchConclusions),
    stopReason: trimmedText("stopReason", 2_000).nullish().transform((value) => value ?? null),
  })
  .superRefine((input, context) => {
    if (input.conclusion !== "completed" && input.stopReason === null) {
      context.addIssue({
        code: "custom",
        message: `stopReason is required when the conclusion is ${input.conclusion}`,
        path: ["stopReason"],
      });
    }
  });

export type CompleteResearchRequestInput = z.infer<typeof completeResearchRequestSchema>;

export const cancelResearchRequestSchema = z.object({ reason: trimmedText("reason", 2_000) });

export type CancelResearchRequestInput = z.infer<typeof cancelResearchRequestSchema>;

export const researchRequestFilterSchema = z.object({
  originIntentId: idText.optional(),
  status: z
    .enum(["requested", "running", "completed", "insufficient", "not_needed", "cancelled"])
    .optional(),
});

export type ResearchRequestFilter = z.infer<typeof researchRequestFilterSchema>;

export const parseCreateResearchRequestInput = (input: unknown): CreateResearchRequestInput =>
  parseWith(createResearchRequestSchema, input, "Research Request");

export const parseRegisterResearchResultInput = (input: unknown): RegisterResearchResultInput =>
  parseWith(registerResearchResultSchema, input, "Research Result");

export const parseRegisterResearchSynthesisInput = (input: unknown): RegisterResearchSynthesisInput =>
  parseWith(registerResearchSynthesisSchema, input, "Research Synthesis");

export const parseCompleteResearchRequestInput = (input: unknown): CompleteResearchRequestInput =>
  parseWith(completeResearchRequestSchema, input, "Research Request");

export const parseCancelResearchRequestInput = (input: unknown): CancelResearchRequestInput =>
  parseWith(cancelResearchRequestSchema, input, "Research Request");

export const parseResearchRequestFilter = (input: unknown): ResearchRequestFilter =>
  parseWith(researchRequestFilterSchema, input, "Research Request filter");
