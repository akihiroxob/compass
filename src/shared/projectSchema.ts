import { z } from "zod";
import { ValidationError } from "../application/error/ValidationError.ts";

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

const webUrl = z
  .url("must be a valid URL")
  .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
    message: "must use http or https",
  });

const namedLinkSchema = z.object({
  name: trimmedText("name", 100),
  url: webUrl,
});

const principleSchema = trimmedText("principle", 500);
const constraintSchema = trimmedText("constraint", 500);
const resourceSchema = namedLinkSchema.extend({ kind: optionalText(100) });

export const createProjectSchema = z.object({
  name: trimmedText("name", 100),
  description: optionalText(1_000),
  mission: trimmedText("mission", 2_000),
  vision: optionalText(2_000),
  principles: z.array(principleSchema).max(20).default([]),
  constraints: z.array(constraintSchema).max(20).default([]),
  repositories: z.array(namedLinkSchema).max(20).default([]),
  resources: z.array(resourceSchema).max(50).default([]),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/** 更新入力で既存の子要素を維持するための識別子。同じ配列内で重複させない。 */
const optionalId = z.string().min(1, "id must not be empty").optional();

const uniqueIds = (items: { id?: string }[], context: z.RefinementCtx) => {
  const seen = new Set<string>();
  items.forEach(({ id }, index) => {
    if (id === undefined) return;
    if (seen.has(id)) {
      context.addIssue({ code: "custom", message: "id must be unique", path: [index, "id"] });
    }
    seen.add(id);
  });
};

/**
 * 部分更新の入力。未指定の項目は変更せず、指定した項目は作成時と同じ規則で検証する。
 * description / vision は `null` または空文字でクリアできる。配列は指定すると全体を置き換える。
 */
export const updateProjectSchema = z
  .object({
    name: trimmedText("name", 100).optional(),
    description: clearableText(1_000).optional(),
    mission: trimmedText("mission", 2_000).optional(),
    vision: clearableText(2_000).optional(),
    principles: z.array(principleSchema).max(20).optional(),
    constraints: z.array(constraintSchema).max(20).optional(),
    repositories: z.array(namedLinkSchema.extend({ id: optionalId })).max(20).superRefine(uniqueIds).optional(),
    resources: z.array(resourceSchema.extend({ id: optionalId })).max(50).superRefine(uniqueIds).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "at least one field to update is required",
  });

export type UpdateProjectInput = z.infer<typeof updateProjectSchema>;

export const parseWith = <T extends z.ZodType>(
  schema: T,
  input: unknown,
  subject = "Project",
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

export const parseCreateProjectInput = (input: unknown): CreateProjectInput =>
  parseWith(createProjectSchema, input);

export const parseUpdateProjectInput = (input: unknown): UpdateProjectInput =>
  parseWith(updateProjectSchema, input);
