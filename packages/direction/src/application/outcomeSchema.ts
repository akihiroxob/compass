import { z } from "zod";
import { clearableText, optionalText, parseWith, trimmedText, ValidationError } from "@compass/shared";
import type { CreateOutcomeInput, UpdateOutcomeInput } from "../domain/OutcomeRepository.ts";
import { causalEvaluationMethods, evaluationMethods, problemEvidenceKinds, problemEvidenceStatuses } from "../domain/Outcome.ts";

export const successCriterionSchema = z.object({
  description: trimmedText("description", 500),
  measurement: trimmedText("measurement", 1_000),
  target: optionalText(200),
});

export type SuccessCriterionInput = z.infer<typeof successCriterionSchema>;

/** 1つのOutcomeが持てる課題、1つの課題が持てる根拠参照の上限。 */
export const maxOutcomeProblems = 10;
export const maxProblemEvidence = 10;

const problemEvidenceSchema = z.object({
  kind: z.enum(problemEvidenceKinds),
  id: z.string().trim().min(1, "evidence id is required"),
});

/** 評価計画。A/B・差分の差分法は因果を主張する方法なので、適用前提の記載を必須にする（解析はしない）。 */
export const evaluationPlanSchema = z
  .object({
    question: trimmedText("question", 500),
    method: z.enum(evaluationMethods, { error: `method must be one of: ${evaluationMethods.join(", ")}` }),
    premises: optionalText(2_000),
    observationPeriod: optionalText(200),
    decisionCriteria: trimmedText("decisionCriteria", 2_000),
    stopCriteria: optionalText(2_000),
  })
  .superRefine((plan, context) => {
    if (causalEvaluationMethods.includes(plan.method) && plan.premises === null) {
      context.addIssue({ code: "custom", path: ["premises"], message: `premises is required for ${plan.method}: state how its assumptions are met` });
    }
  });

/**
 * 課題（Problem Statement）と根拠・解決策の仮説。観測（observation）と原因の仮説（causeHypothesis）は別の項目で、
 * 観測済み・反証の課題は観測内容と1件以上の根拠参照を必須にする。原因を確定する項目は持たない。
 */
export const outcomeProblemSchema = z
  .object({
    id: z.string().trim().min(1).optional(),
    statement: trimmedText("statement", 500),
    evidenceStatus: z.enum(problemEvidenceStatuses),
    observation: optionalText(2_000),
    causeHypothesis: optionalText(2_000),
    solutionHypothesis: optionalText(2_000),
    evaluationPlan: evaluationPlanSchema.nullable().optional().transform((value) => value ?? null),
    evidence: z
      .array(problemEvidenceSchema)
      .max(maxProblemEvidence, `at most ${maxProblemEvidence} evidence references are allowed`)
      .optional()
      .transform((value) => value ?? []),
  })
  .superRefine((problem, context) => {
    if (problem.evidenceStatus === "insufficient") return;
    if (problem.observation === null) {
      context.addIssue({ code: "custom", path: ["observation"], message: "observation is required when evidence is observed or refuted" });
    }
    if (problem.evidence.length === 0) {
      context.addIssue({ code: "custom", path: ["evidence"], message: "at least one evidence reference is required when evidence is observed or refuted" });
    }
    const keys = problem.evidence.map((item) => `${item.kind}:${item.id}`);
    if (new Set(keys).size !== keys.length) context.addIssue({ code: "custom", path: ["evidence"], message: "evidence references must be unique" });
  });

const outcomeProblemsSchema = z
  .array(outcomeProblemSchema)
  .max(maxOutcomeProblems, `at most ${maxOutcomeProblems} problems are allowed`)
  .superRefine((problems, context) => {
    const ids = problems.flatMap((problem) => (problem.id ? [problem.id] : []));
    if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "problem ids must be unique" });
  });

/** 成功条件はOutcomeの作成時に固定する。0件のOutcomeは登録できない。課題は任意（0件可）。 */
export const createOutcomeSchema = z.object({
  /** 判断の元にしたIntentの版（必須）。現在版と一致するときだけ作成でき、省略して現在版へ暗黙に付け替えない。 */
  intentVersion: z.number().int().min(1),
  title: trimmedText("title", 100),
  description: trimmedText("description", 2_000),
  hypothesis: optionalText(2_000),
  rationale: trimmedText("rationale", 2_000),
  successCriteria: z
    .array(successCriterionSchema)
    .min(1, "at least one success criterion is required")
    .max(10, "at most 10 success criteria are allowed"),
  problems: outcomeProblemsSchema.optional().transform((value) => value ?? []),
});

/**
 * activeなOutcomeで変更できる項目。hypothesisは`null`または空文字でクリアできる。
 * problemsは一覧全体の置換で、古い版への上書きを防ぐため`expectedRevision`を必須にする。
 */
const updateOutcomeSchema = z
  .object({
    /** Intentの現在版を確認したことの記録。指定した場合は現在版と一致するときだけ更新でき、再計画の対象から外れる。 */
    intentVersion: z.number().int().min(1).optional(),
    title: trimmedText("title", 100).optional(),
    hypothesis: clearableText(2_000).optional(),
    problems: outcomeProblemsSchema.optional(),
    expectedRevision: z.number().int().min(1).optional(),
  })
  .superRefine((input, context) => {
    if (input.problems !== undefined && input.expectedRevision === undefined) {
      context.addIssue({ code: "custom", path: ["expectedRevision"], message: "expectedRevision is required when problems are updated" });
    }
  });

/** 作成後に変更できない項目。更新入力に含まれた場合は黙って無視せず、呼び出し側が競合として拒否する。 */
export const fixedOutcomeFields = ["description", "rationale", "successCriteria"] as const;

/**
 * 更新入力を検証し、変更する項目と、入力に含まれた固定項目を分けて返す。
 * 固定項目のみの入力は「更新項目なし」の入力エラーにせず、固定項目の変更として呼び出し側が拒否できるようにする。
 */
export const parseUpdateOutcomeInput = (
  input: unknown,
): { changes: UpdateOutcomeInput; fixedFields: string[] } => {
  const changes = parseWith(updateOutcomeSchema, input, "Outcome");
  const fixedFields = fixedOutcomeFields.filter(
    (field) => (input as Record<string, unknown>)[field] !== undefined,
  );
  const { expectedRevision: _expected, ...fields } = changes;
  if (fixedFields.length === 0 && Object.values(fields).every((value) => value === undefined)) {
    throw new ValidationError("Outcome input is invalid", [
      { path: "", message: "at least one field to update is required" },
    ]);
  }
  return { changes, fixedFields };
};

export const cancelOutcomeSchema = z.object({ reason: trimmedText("reason", 2_000) });

export type CancelOutcomeInput = z.infer<typeof cancelOutcomeSchema>;

export const parseCreateOutcomeInput = (input: unknown): CreateOutcomeInput =>
  parseWith(createOutcomeSchema, input, "Outcome");

export const parseCancelOutcomeInput = (input: unknown): CancelOutcomeInput =>
  parseWith(cancelOutcomeSchema, input, "Outcome");
