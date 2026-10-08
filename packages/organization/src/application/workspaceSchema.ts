import { z } from "zod";
import { clearableText, optionalText, parseWith, trimmedText } from "@compass/shared";
import type { CreateWorkspaceInput, UpdateWorkspaceInput } from "../domain/WorkspaceRepository.ts";

/** 値の規則はProjectの戦略値（`@compass/direction`の`projectSchema.ts`）と同じにし、移行で値を写せるようにする。 */
const principleSchema = trimmedText("principle", 500);
const constraintSchema = trimmedText("constraint", 500);

export const createWorkspaceSchema = z.object({
  name: trimmedText("name", 100),
  mission: trimmedText("mission", 2_000),
  vision: optionalText(2_000),
  principles: z.array(principleSchema).max(20).default([]),
  constraints: z.array(constraintSchema).max(20).default([]),
});

/** 部分更新の入力。未指定の項目は変更しない。visionは`null`または空文字でクリアできる。 */
export const updateWorkspaceSchema = z
  .object({
    name: trimmedText("name", 100).optional(),
    mission: trimmedText("mission", 2_000).optional(),
    vision: clearableText(2_000).optional(),
    principles: z.array(principleSchema).max(20).optional(),
    constraints: z.array(constraintSchema).max(20).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "at least one field to update is required",
  });

/** archiveは理由必須。statusなどserver管理の項目は入力から受け取らない。 */
export const archiveWorkspaceSchema = z.object({ reason: trimmedText("reason", 2_000) });

export type ArchiveWorkspaceInput = z.infer<typeof archiveWorkspaceSchema>;

export const workspaceStatusFilterSchema = z.object({
  status: z.enum(["active", "archived"]).default("active"),
});

export const parseCreateWorkspaceInput = (input: unknown): CreateWorkspaceInput =>
  parseWith(createWorkspaceSchema, input, "Workspace");

export const parseUpdateWorkspaceInput = (input: unknown): UpdateWorkspaceInput =>
  parseWith(updateWorkspaceSchema, input, "Workspace");

export const parseArchiveWorkspaceInput = (input: unknown): ArchiveWorkspaceInput =>
  parseWith(archiveWorkspaceSchema, input, "Workspace");

/** 一覧の絞り込み。未指定はactiveのみ。 */
export const parseWorkspaceStatusFilter = (status: string | undefined): "active" | "archived" =>
  parseWith(workspaceStatusFilterSchema, { status }, "Workspace").status;
