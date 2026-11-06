import { optionalText, parseWith, trimmedText } from "@compass/shared";
import { z } from "zod";
import { activityEntityKinds, type ActivityReference, type ActivityTarget, type ActivityTargetKind } from "../domain/Activity.ts";
import type { ActivityStreamPosition } from "./port/ActivityStore.ts";

export const maximumActivitySummaryLength = 500;
export const maximumActivityBodyLength = 20_000;
export const maximumActivityRefs = 20;
export const defaultActivityPageSize = 20;
export const maximumActivityPageSize = 100;

const activityType = z
  .string()
  .trim()
  .min(1, "type is required")
  .max(100, "type must be 100 characters or fewer")
  .regex(/^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)*$/, "type must be dot-separated lowercase words (e.g. research.summary)");

const identifier = (label: string) => trimmedText(label, 200);

const absoluteUrl = z
  .string()
  .trim()
  .max(2_000, "url must be 2000 characters or fewer")
  .refine((value) => {
    try {
      const { protocol } = new URL(value);
      return protocol === "https:" || protocol === "http:";
    } catch {
      return false;
    }
  }, "url must be an absolute http(s) URL");

const referenceSchema = z.union([
  z
    .object({
      kind: z.literal("project_resource"),
      resourceId: identifier("resourceId"),
      path: optionalText(1_000),
      revision: optionalText(200),
    })
    .strict(),
  z.object({ kind: z.literal("url"), url: absoluteUrl }).strict(),
  z.object({ kind: z.enum(activityEntityKinds), id: identifier("id") }).strict(),
]);

const recordActivityFields = {
  type: activityType,
  summary: trimmedText("summary", maximumActivitySummaryLength),
  body: optionalText(maximumActivityBodyLength),
  refs: z.array(referenceSchema).max(maximumActivityRefs, `refs must be ${maximumActivityRefs} items or fewer`).default([]),
  role: identifier("role").optional(),
  correctsActivityId: identifier("correctsActivityId").optional(),
  occurredAt: z.number().int().positive().optional(),
  requestId: identifier("requestId"),
};

/**
 * 明示記録の入力。対象はscopeごとに`projectId`または`workspaceId`の一方だけで指定する。
 * Agentの実行単位（`runId`等）や成果物の本文は受け付けない（strictで未知の項目を拒否する）。
 * Principalは入力に持たず、Bearerから解決した値だけを使う。
 */
const recordActivitySchemas = {
  project: z.object({ projectId: identifier("projectId"), ...recordActivityFields }).strict(),
  workspace: z.object({ workspaceId: identifier("workspaceId"), ...recordActivityFields }).strict(),
} satisfies Record<ActivityTargetKind, z.ZodType>;

type RecordActivityFields = Omit<z.output<typeof recordActivitySchemas.project>, "projectId" | "refs"> & { refs: ActivityReference[] };

/** 検証済みの明示記録。`target`は入力の`projectId` / `workspaceId`から作る。 */
export type RecordActivityInput = RecordActivityFields & { target: ActivityTarget };

export const parseRecordActivityInput = (kind: ActivityTargetKind, input: unknown): RecordActivityInput => {
  const parsed = parseWith(recordActivitySchemas[kind], input, "Activity") as Record<string, unknown>;
  const { projectId, workspaceId, ...fields } = parsed;
  return { ...(fields as RecordActivityFields), target: { kind, id: (projectId ?? workspaceId) as string } };
};

const optionalCursor = z.number().int().min(0).optional();

const activityQuerySchema = z
  .object({
    afterCursor: optionalCursor,
    beforeCursor: z.number().int().min(1).optional(),
    limit: z.number().int().min(1).max(maximumActivityPageSize).default(defaultActivityPageSize),
    principalId: identifier("principalId").optional(),
    role: identifier("role").optional(),
    type: activityType.optional(),
    refKind: z.enum([...activityEntityKinds, "project_resource"]).optional(),
    refId: identifier("refId").optional(),
  })
  .strict()
  .refine((query) => query.afterCursor === undefined || query.beforeCursor === undefined, {
    message: "afterCursor and beforeCursor cannot be combined",
    path: ["beforeCursor"],
  })
  .refine((query) => (query.refKind === undefined) === (query.refId === undefined), {
    message: "refKind and refId must be given together",
    path: ["refId"],
  });

export type ActivityQueryInput = z.input<typeof activityQuerySchema>;

export const parseActivityQuery = (input: unknown) => parseWith(activityQuerySchema, input ?? {}, "Activity query");

export const maximumActivitySearchLength = 200;

/** 横断取得の位置。`{発生時刻}.{cursor}`の不透明な文字列で、応答の`nextCursor`をそのまま渡す。 */
const streamCursorPattern = /^(\d{1,16})\.(\d{1,16})$/;
export const formatActivityStreamCursor = ({ occurredAt, cursor }: ActivityStreamPosition): string => `${occurredAt}.${cursor}`;

const streamCursor = z
  .string()
  .regex(streamCursorPattern, "cursor must be a value returned as nextCursor")
  .transform((value): ActivityStreamPosition => {
    const [, occurredAt, cursor] = streamCursorPattern.exec(value)!;
    return { occurredAt: Number(occurredAt), cursor: Number(cursor) };
  });

const activityStreamQuerySchema = z
  .object({
    after: streamCursor.optional(),
    before: streamCursor.optional(),
    limit: z.number().int().min(1).max(maximumActivityPageSize).default(defaultActivityPageSize),
    projectId: identifier("projectId").optional(),
    workspaceOnly: z.boolean().optional(),
    type: activityType.optional(),
    from: z.number().int().min(0).optional(),
    to: z.number().int().min(0).optional(),
    text: trimmedText("text", maximumActivitySearchLength).optional(),
  })
  .strict()
  .refine((query) => query.after === undefined || query.before === undefined, {
    message: "after and before cannot be combined",
    path: ["before"],
  })
  .refine((query) => query.projectId === undefined || query.workspaceOnly !== true, {
    message: "projectId and workspaceOnly cannot be combined",
    path: ["workspaceOnly"],
  })
  .refine((query) => query.from === undefined || query.to === undefined || query.from <= query.to, {
    message: "from must not be later than to",
    path: ["to"],
  });

export type ActivityStreamQueryInput = z.input<typeof activityStreamQuerySchema>;
export const parseActivityStreamQuery = (input: unknown) => parseWith(activityStreamQuerySchema, input ?? {}, "Activity stream query");
