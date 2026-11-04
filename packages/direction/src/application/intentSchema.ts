import { z } from "zod";
import { clearableText, optionalText, parseWith, trimmedText } from "@compass/shared";
import type { CreateIntentInput, UpdateIntentInput } from "../domain/IntentRepository.ts";

/** 暦日として存在する`YYYY-MM-DD`か。時刻・タイムゾーンは持たない。 */
const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const calendarDate = z
  .string()
  .trim()
  .refine((value) => value === "" || isCalendarDate(value), "must be a calendar date in YYYY-MM-DD format");

/** 作成時の任意の目標日。未指定・`null`・空文字は未設定。 */
const optionalDate = calendarDate.optional().nullable().transform((value) => value || null);
/** 更新時の目標日。`null`と空文字はクリア、未指定（undefined）は変更なし。 */
const clearableDate = calendarDate.nullable().transform((value) => value || null);

/**
 * Intent（ビジネス目標）の入力契約。Web UIとMCPが同じschemaを使う。
 * 必須: title（100文字まで）・desiredState（2,000文字まで）。
 * 任意: background・audience・constraints・completionDefinition（各2,000文字まで）、targetDate（`YYYY-MM-DD`）。
 */
export const createIntentSchema = z.object({
  title: trimmedText("title", 100),
  desiredState: trimmedText("desiredState", 2_000),
  background: optionalText(2_000),
  audience: optionalText(2_000),
  constraints: optionalText(2_000),
  completionDefinition: optionalText(2_000),
  targetDate: optionalDate,
});

/**
 * Active中のIntentの部分更新。未指定の項目は変更せず、指定した項目は作成時と同じ規則で検証する。
 * 任意項目は`null`または空文字でクリアできる。
 */
export const updateIntentSchema = z
  .object({
    title: trimmedText("title", 100).optional(),
    desiredState: trimmedText("desiredState", 2_000).optional(),
    background: clearableText(2_000).optional(),
    audience: clearableText(2_000).optional(),
    constraints: clearableText(2_000).optional(),
    completionDefinition: clearableText(2_000).optional(),
    targetDate: clearableDate.optional(),
  })
  .refine((input) => Object.values(input).some((value) => value !== undefined), {
    message: "at least one field to update is required",
  });

export const abandonIntentSchema = z.object({ reason: optionalText(2_000) });

export type AbandonIntentInput = z.infer<typeof abandonIntentSchema>;

export const parseCreateIntentInput = (input: unknown): CreateIntentInput =>
  parseWith(createIntentSchema, input, "Intent");

export const parseUpdateIntentInput = (input: unknown): UpdateIntentInput =>
  parseWith(updateIntentSchema, input, "Intent");

export const parseAbandonIntentInput = (input: unknown): AbandonIntentInput =>
  parseWith(abandonIntentSchema, input, "Intent");
