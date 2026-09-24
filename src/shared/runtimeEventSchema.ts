import { z } from "zod";
import { runtimeEventAckOutcomes } from "../domain/model/RuntimeEventDelivery.ts";
import { parseWith, trimmedText } from "./projectSchema.ts";

export const runtimeEventQuerySchema = z.object({
  afterCursor: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(500).default(100),
});

export type RuntimeEventQuery = z.infer<typeof runtimeEventQuerySchema>;

export const parseRuntimeEventQuery = (input: unknown): RuntimeEventQuery =>
  parseWith(runtimeEventQuerySchema, input ?? {}, "Runtime event query");

/** 失敗の結果は理由が必須。processedは失敗ではないため理由を受け付けない（黙って捨てない）。 */
export const runtimeEventAckSchema = z
  .object({
    eventId: z.string().min(1, "eventId is required"),
    outcome: z.enum(runtimeEventAckOutcomes, {
      error: `outcome must be one of: ${runtimeEventAckOutcomes.join(", ")}`,
    }),
    reason: trimmedText("reason", 1_000).optional(),
  })
  .superRefine((input, context) => {
    if (input.outcome === "processed" && input.reason !== undefined) {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is only accepted for failures" });
    }
    if (input.outcome !== "processed" && input.reason === undefined) {
      context.addIssue({ code: "custom", path: ["reason"], message: "reason is required for failures" });
    }
  });

export type RuntimeEventAckInput = z.infer<typeof runtimeEventAckSchema>;

export const parseRuntimeEventAckInput = (input: unknown): RuntimeEventAckInput =>
  parseWith(runtimeEventAckSchema, input, "Runtime event ack");
