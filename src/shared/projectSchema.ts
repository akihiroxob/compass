import { z } from "zod";
import { ValidationError } from "../application/error/ValidationError.ts";

const trimmedText = (label: string, maximum: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} is required`)
    .max(maximum, `${label} must be ${maximum} characters or fewer`);

const optionalText = (maximum: number) =>
  z
    .string()
    .trim()
    .max(maximum, `must be ${maximum} characters or fewer`)
    .optional()
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

export const createProjectSchema = z.object({
  name: trimmedText("name", 100),
  description: optionalText(1_000),
  mission: trimmedText("mission", 2_000),
  vision: optionalText(2_000),
  principles: z.array(trimmedText("principle", 500)).max(20).default([]),
  constraints: z.array(trimmedText("constraint", 500)).max(20).default([]),
  repositories: z.array(namedLinkSchema).max(20).default([]),
  resources: z
    .array(namedLinkSchema.extend({ kind: optionalText(100) }))
    .max(50)
    .default([]),
});

export type CreateProjectInput = z.infer<typeof createProjectSchema>;

export const parseCreateProjectInput = (input: unknown): CreateProjectInput => {
  const result = createProjectSchema.safeParse(input);
  if (result.success) return result.data;

  throw new ValidationError(
    "Project input is invalid",
    result.error.issues.map((issue) => ({
      path: issue.path.join("."),
      message: issue.message,
    })),
  );
};
