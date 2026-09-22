import { z } from "zod";
import { parseWith } from "./projectSchema.ts";

export const runtimeEventQuerySchema = z.object({
  afterCursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

export type RuntimeEventQuery = z.infer<typeof runtimeEventQuerySchema>;

export const parseRuntimeEventQuery = (input: unknown): RuntimeEventQuery =>
  parseWith(runtimeEventQuerySchema, input ?? {}, "Runtime event query");
