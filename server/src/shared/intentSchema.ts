import { z } from "zod";
import { clearableText, optionalText, parseWith, trimmedText } from "./projectSchema.ts";

export const createIntentSchema = z.object({
  title: trimmedText("title", 100),
  desiredState: trimmedText("desiredState", 2_000),
  completionDefinition: optionalText(2_000),
});

export type CreateIntentInput = z.infer<typeof createIntentSchema>;

/**
 * Active中のIntentの部分更新。未指定の項目は変更せず、指定した項目は作成時と同じ規則で検証する。
 * completionDefinitionは`null`または空文字でクリアできる。
 */
export const updateIntentSchema = z
  .object({
    title: trimmedText("title", 100).optional(),
    desiredState: trimmedText("desiredState", 2_000).optional(),
    completionDefinition: clearableText(2_000).optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "at least one field to update is required",
  });

export type UpdateIntentInput = z.infer<typeof updateIntentSchema>;

export const abandonIntentSchema = z.object({ reason: optionalText(2_000) });

export type AbandonIntentInput = z.infer<typeof abandonIntentSchema>;

export const parseCreateIntentInput = (input: unknown): CreateIntentInput =>
  parseWith(createIntentSchema, input, "Intent");

export const parseUpdateIntentInput = (input: unknown): UpdateIntentInput =>
  parseWith(updateIntentSchema, input, "Intent");

export const parseAbandonIntentInput = (input: unknown): AbandonIntentInput =>
  parseWith(abandonIntentSchema, input, "Intent");
