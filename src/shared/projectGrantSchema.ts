import { z } from "zod";
import { projectRoles } from "../constants/ProjectRole.ts";
import { parseWith } from "./projectSchema.ts";

const controlCharacter = /\p{Cc}/u;

/** Bearerの値（Principal）と同じ規則。trim後1〜100文字、制御文字なし、大文字小文字は区別する。 */
export const principalIdSchema = z
  .string()
  .trim()
  .min(1, "principalId is required")
  .max(100, "principalId must be 100 characters or fewer")
  .refine((value) => !controlCharacter.test(value), "principalId must not contain control characters");

export const projectRoleSchema = z.enum(projectRoles, {
  error: `role must be one of: ${projectRoles.join(", ")}`,
});

export const projectGrantSchema = z.object({
  principalId: principalIdSchema,
  role: projectRoleSchema,
});

export type ProjectGrantInput = z.infer<typeof projectGrantSchema>;

/** 発行の本文、取消のpath（role・principalId）で共通に使う。 */
export const parseProjectGrantInput = (input: unknown): ProjectGrantInput =>
  parseWith(projectGrantSchema, input, "Grant");
