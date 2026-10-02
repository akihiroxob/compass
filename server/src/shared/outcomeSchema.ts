import { z } from "zod";
import { ValidationError } from "../application/error/ValidationError.ts";
import { clearableText, optionalText, parseWith, trimmedText } from "./projectSchema.ts";

export const successCriterionSchema = z.object({
  description: trimmedText("description", 500),
  measurement: trimmedText("measurement", 1_000),
  target: optionalText(200),
});

export type SuccessCriterionInput = z.infer<typeof successCriterionSchema>;

/** 成功条件はOutcomeの作成時に固定する。0件のOutcomeは登録できない。 */
export const createOutcomeSchema = z.object({
  title: trimmedText("title", 100),
  description: trimmedText("description", 2_000),
  hypothesis: optionalText(2_000),
  rationale: trimmedText("rationale", 2_000),
  successCriteria: z
    .array(successCriterionSchema)
    .min(1, "at least one success criterion is required")
    .max(10, "at most 10 success criteria are allowed"),
});

export type CreateOutcomeInput = z.infer<typeof createOutcomeSchema>;

/** activeなOutcomeで変更できる項目。hypothesisは`null`または空文字でクリアできる。 */
const updateOutcomeSchema = z.object({
  title: trimmedText("title", 100).optional(),
  hypothesis: clearableText(2_000).optional(),
});

export type UpdateOutcomeInput = z.infer<typeof updateOutcomeSchema>;

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
  if (fixedFields.length === 0 && Object.values(changes).every((value) => value === undefined)) {
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
