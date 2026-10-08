import { z } from "zod";
import { clearableText, optionalText, parseWith, trimmedText } from "@compass/shared";
import type { CreateProjectInput, CreateWorkspaceProjectInput, UpdateProjectInput } from "../domain/ProjectRepository.ts";

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

/** 既存のWorkspaceへのProject作成。Mission等はWorkspaceの正本を使うため受け取らない（未知の項目は無視する）。 */
export const createWorkspaceProjectSchema = createProjectSchema.pick({
  name: true,
  description: true,
  repositories: true,
  resources: true,
});

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

/** archiveは理由必須。statusなどserver管理の項目は入力から受け取らない。 */
export const archiveProjectSchema = z.object({ reason: trimmedText("reason", 2_000) });

export type ArchiveProjectInput = z.infer<typeof archiveProjectSchema>;

export const projectStatusFilterSchema = z.object({
  status: z.enum(["active", "archived"]).default("active"),
});

export const parseCreateProjectInput = (input: unknown): CreateProjectInput =>
  parseWith(createProjectSchema, input, "Project");

export const parseCreateWorkspaceProjectInput = (input: unknown): CreateWorkspaceProjectInput =>
  parseWith(createWorkspaceProjectSchema, input, "Project");

export const parseUpdateProjectInput = (input: unknown): UpdateProjectInput =>
  parseWith(updateProjectSchema, input, "Project");

export const parseArchiveProjectInput = (input: unknown): ArchiveProjectInput =>
  parseWith(archiveProjectSchema, input, "Project");

/** 一覧の絞り込み。未指定はactiveのみ。`all`などは受け付けず、issueのpathは`status`になる。 */
export const parseProjectStatusFilter = (status: string | undefined): "active" | "archived" =>
  parseWith(projectStatusFilterSchema, { status }, "Project").status;
