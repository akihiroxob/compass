import { z } from "zod";
import { criterionVerdicts } from "../domain/model/OutcomeEvaluation.ts";
import { parseWith, trimmedText } from "./projectSchema.ts";

const criterionJudgmentSchema = z
  .object({
    criterionId: trimmedText("criterionId", 200),
    verdict: z.enum(criterionVerdicts, { error: `verdict must be one of: ${criterionVerdicts.join(", ")}` }),
    rationale: trimmedText("rationale", 4_000),
    /** 根拠にしたExecution Evidence参照のid（`get_evaluator_context`の`execution.evidence[].id`）。 */
    evidenceIds: z
      .array(trimmedText("evidenceId", 200))
      .max(200, "evidenceIds must have 200 items or fewer")
      .default([])
      .transform((ids) => [...new Set(ids)]),
  })
  .superRefine((judgment, context) => {
    // 観測した根拠なしに成功・失敗を断定させない。観測できなかったCriterionは`insufficient_evidence`で残す。
    if (judgment.verdict !== "insufficient_evidence" && judgment.evidenceIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evidenceIds"],
        message: `evidenceIds is required for ${judgment.verdict}; use insufficient_evidence when the Evidence could not be observed`,
      });
    }
  });

/**
 * Evaluatorが送る内容。総合結果は指定させず、Criterionの判定から導出する。principalIdは入力に持たない
 * （来歴のPrincipalはBearerから解決した値だけ）。
 */
export const recordOutcomeEvaluationSchema = z.object({
  /** transportの再送を同じ操作として扱うkey。Project内で一意で、同じkeyで異なる内容を送ると競合になる。 */
  requestKey: trimmedText("requestKey", 200),
  /** この評価Runを特定できる参照。 */
  runRef: trimmedText("runRef", 200),
  criteria: z
    .array(criterionJudgmentSchema)
    .min(1, "criteria must have at least 1 item")
    .max(10, "criteria must have 10 items or fewer")
    .superRefine((criteria, context) => {
      const seen = new Set<string>();
      criteria.forEach((judgment, index) => {
        if (seen.has(judgment.criterionId)) {
          context.addIssue({
            code: "custom",
            path: [index, "criterionId"],
            message: `criterionId ${judgment.criterionId} is evaluated more than once`,
          });
        }
        seen.add(judgment.criterionId);
      });
    }),
});

export type RecordOutcomeEvaluationInput = z.infer<typeof recordOutcomeEvaluationSchema>;

export const parseRecordOutcomeEvaluationInput = (input: unknown): RecordOutcomeEvaluationInput =>
  parseWith(recordOutcomeEvaluationSchema, input, "Outcome Evaluation");
