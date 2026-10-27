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

/**
 * Repository内の相対path。Compass serverのローカルfilesystem pathとして扱わないため、
 * 絶対path（先頭が`/`、Windowsドライブレター）とpath traversal（`..`セグメント）を拒否する。
 */
export const repositoryRelativePath = trimmedText("path", 1_000).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !value.split(/[\\/]+/).some((segment) => segment === ".."),
  { message: "must be a relative path inside the Repository, without a leading slash or .. segments" },
);

/** 短縮SHAを許さず、Git（SHA-1）の完全な40桁16進数だけを受け付ける。 */
export const fullCommitSha = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA");

export const httpUrl = (label: string) =>
  z
    .url(`${label} must be a valid URL`)
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: `${label} must use http or https`,
    });

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
