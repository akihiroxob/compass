import { z } from "zod";
import { directionDecisionRecordTypes } from "../domain/model/DirectionDecision.ts";
import { createOutcomeSchema } from "./outcomeSchema.ts";
import { parseWith, trimmedText } from "./projectSchema.ts";

const idText = trimmedText("id", 200);

/** transportの再送を同じ操作として扱うためのkey。同じkeyで異なる内容を送った場合は競合になる。 */
const requestKey = trimmedText("requestKey", 200);

const usedSynthesisSchema = z.object({
  synthesisId: idText,
  version: z.number().int().min(1),
});

const decisionCommonSchema = {
  intentId: idText,
  judgment: trimmedText("judgment", 2_000),
  reason: trimmedText("reason", 4_000),
  options: z.array(trimmedText("option", 1_000)).max(20).default([]),
  usedSyntheses: z.array(usedSynthesisSchema).max(50).default([]),
  usedFindingIds: z.array(idText).max(100).default([]),
  requestKey,
  runRef: trimmedText("runRef", 500),
};

const checkUniqueReferences = (
  input: { usedSyntheses: { synthesisId: string }[]; usedFindingIds: string[] },
  context: z.RefinementCtx,
) => {
  const synthesisIds = input.usedSyntheses.map((item) => item.synthesisId);
  if (new Set(synthesisIds).size !== synthesisIds.length) {
    context.addIssue({ code: "custom", message: "usedSyntheses.synthesisId must be unique", path: ["usedSyntheses"] });
  }
  if (new Set(input.usedFindingIds).size !== input.usedFindingIds.length) {
    context.addIssue({ code: "custom", message: "usedFindingIds must be unique", path: ["usedFindingIds"] });
  }
};

/** next_outcome以外の5種。next_outcomeはOutcomeと同一transactionで保存するdecideNextOutcomeSchemaを使う。 */
export const createDirectionDecisionSchema = z
  .object({ ...decisionCommonSchema, type: z.enum(directionDecisionRecordTypes) })
  .superRefine(checkUniqueReferences);

export type CreateDirectionDecisionInput = z.infer<typeof createDirectionDecisionSchema>;

/** successCriteriaを含むOutcome入力は既存のcreateOutcomeSchemaをそのまま使い、固定Success Criteriaの規則を重複させない。 */
export const decideNextOutcomeSchema = z
  .object({ ...decisionCommonSchema, outcome: createOutcomeSchema })
  .superRefine(checkUniqueReferences);

export type DecideNextOutcomeInput = z.infer<typeof decideNextOutcomeSchema>;

export const parseCreateDirectionDecisionInput = (input: unknown): CreateDirectionDecisionInput =>
  parseWith(createDirectionDecisionSchema, input, "Direction Decision");

export const parseDecideNextOutcomeInput = (input: unknown): DecideNextOutcomeInput =>
  parseWith(decideNextOutcomeSchema, input, "Direction Decision");
