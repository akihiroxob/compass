import { optionalText, parseWith, trimmedText } from "@compass/shared";
import { z } from "zod";
import { activityEntityKinds, type ActivityReference } from "../domain/Activity.ts";

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

/**
 * 明示記録の入力。Agentの実行単位（`runId`等）や成果物の本文は受け付けない（strictで未知の項目を拒否する）。
 * Principalは入力に持たず、Bearerから解決した値だけを使う。
 */
const recordActivitySchema = z
  .object({
    projectId: identifier("projectId"),
    type: activityType,
    summary: trimmedText("summary", maximumActivitySummaryLength),
    body: optionalText(maximumActivityBodyLength),
    refs: z.array(referenceSchema).max(maximumActivityRefs, `refs must be ${maximumActivityRefs} items or fewer`).default([]),
    role: identifier("role").optional(),
    correctsActivityId: identifier("correctsActivityId").optional(),
    occurredAt: z.number().int().positive().optional(),
    requestId: identifier("requestId"),
  })
  .strict();

export type RecordActivityInput = Omit<z.output<typeof recordActivitySchema>, "refs"> & { refs: ActivityReference[] };

export const parseRecordActivityInput = (input: unknown): RecordActivityInput =>
  parseWith(recordActivitySchema, input, "Activity") as RecordActivityInput;

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
