import { z } from "zod";
import { executionRoles } from "../domain/RoleScope.ts";
import { ProjectRole, projectRoles } from "../domain/ProjectRole.ts";
import { parseWith } from "@compass/shared";

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

/** 取消は保存済みの旧Role識別子も受け付ける。 */
export const parseProjectGrantInput = (input: unknown): ProjectGrantInput =>
  parseWith(projectGrantSchema, input, "Grant");

/** 新規発行はProject Execution Roleと、trusted-local開発用の`runtime`だけを許可する。Workspace Roleは拒否する。 */
const newProjectGrantRoles = [...executionRoles, ProjectRole.RUNTIME] as const;
export const parseNewProjectGrantInput = (input: unknown): ProjectGrantInput =>
  parseWith(projectGrantSchema.extend({ role: z.enum(newProjectGrantRoles) }), input, "Grant");
