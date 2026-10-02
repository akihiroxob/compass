import { z } from "zod";
import { ValidationError } from "./errors/ValidationError.ts";

/** 業務に依存しない入力検証の部品（zod）。各Contextのapplication層が自身の入力schemaを組み立てるのに使う。 */

export const trimmedText = (label: string, maximum: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} must be ${maximum} characters or fewer`);

export const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum, `must be ${maximum} characters or fewer`)
    .optional()
    .nullable()
    .transform((value) => value || null);

/** 更新時の任意値。`null`と空文字は「クリア」を意味し、未指定（undefined）は変更なしとして残す。 */
export const clearableText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum, `must be ${maximum} characters or fewer`)
    .nullable()
    .transform((value) => value || null);

/** schemaで検証し、失敗は`ValidationError`（issueごとのpath・message）にする。`subject`はmessageの主語。 */
export const parseWith = <T extends z.ZodType>(
  schema: T,
  input: unknown,
  subject: string,
): z.output<T> => {
  const result = schema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    `${subject} input is invalid`,
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
};
