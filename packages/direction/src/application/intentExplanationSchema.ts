import { z } from "zod";
import { optionalText, parseWith, trimmedText } from "@compass/shared";
import { addCalendarDays, calendarDaysBetween, utcCalendarDate } from "../domain/IntentMetric.ts";
import { allowedBasisTypes, intentExplanationBasisTypes, intentExplanationItemKinds } from "../domain/IntentExplanation.ts";
import type { RecordIntentExplanationInput } from "../domain/IntentExplanationRepository.ts";

const idText = trimmedText("id", 200);

const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const calendarDate = (label: string) =>
  z.string().trim().refine(isCalendarDate, `${label} must be a calendar date in YYYY-MM-DD format`);

/** 分析期間の最大日数（両端を含む）。 */
const maximumPeriodDays = 366;
const maximumItems = 30;
const clockSkewDays = 1;

const basisSchema = z.object({
  type: z.enum(intentExplanationBasisTypes, { error: `type must be one of: ${intentExplanationBasisTypes.join(", ")}` }),
  id: idText,
});

const itemSchema = z.object({
  kind: z.enum(intentExplanationItemKinds, { error: `kind must be one of: ${intentExplanationItemKinds.join(", ")}` }),
  statement: trimmedText("statement", 2_000),
  confidence: z.enum(["low", "medium", "high"]).nullish().transform((value) => value ?? null),
  verification: optionalText(2_000),
  basedOn: z.array(z.number().int().min(0)).max(maximumItems).default([]),
  basis: z.array(basisSchema).max(20).default([]),
});

/**
 * Agentの説明1件。事実は観測値・Finding・Evaluationのいずれかを根拠に持ち、仮説は先行する事実と確認方法・確からしさを持ち、
 * 提案は先行する事実・仮説を根拠にする。事実を持たない説明、根拠の無い事実は記録できない。
 */
export const recordIntentExplanationSchema = (now: number) =>
  z
    .object({
      requestKey: trimmedText("requestKey", 200),
      runRef: trimmedText("runRef", 500),
      metricKey: trimmedText("metricKey", 64),
      periodStart: calendarDate("periodStart"),
      periodEnd: calendarDate("periodEnd"),
      changeFromPrevious: optionalText(2_000),
      relatedOutcomeIds: z.array(idText).max(20).default([]),
      items: z.array(itemSchema).min(1, "items must have at least 1 item").max(maximumItems, `items must have ${maximumItems} items or fewer`),
    })
    .superRefine((input, context) => {
      const issue = (path: (string | number)[], message: string) => context.addIssue({ code: "custom", path, message });
      if (isCalendarDate(input.periodStart) && isCalendarDate(input.periodEnd)) {
        const days = calendarDaysBetween(input.periodStart, input.periodEnd);
        if (days < 0) issue(["periodEnd"], "periodEnd must not be before periodStart");
        else if (days + 1 > maximumPeriodDays) issue(["periodEnd"], `the period must be ${maximumPeriodDays} days or shorter`);
        // 未来の期間を分析したことにしない。タイムゾーン差として1日だけ許容する（UTCの暦日で比較）。
        if (input.periodStart > addCalendarDays(utcCalendarDate(now), clockSkewDays)) {
          issue(["periodStart"], "the period must have started by now");
        }
      }
      if (new Set(input.relatedOutcomeIds).size !== input.relatedOutcomeIds.length) {
        issue(["relatedOutcomeIds"], "relatedOutcomeIds must be unique");
      }
      if (!input.items.some((item) => item.kind === "fact")) issue(["items"], "at least one fact item is required");
      input.items.forEach((item, index) => {
        const at = (field: string) => ["items", index, field];
        const keys = item.basis.map((basis) => `${basis.type}:${basis.id}`);
        if (new Set(keys).size !== keys.length) issue(at("basis"), "basis must not repeat the same record");
        item.basis.forEach((basis, position) => {
          if (!allowedBasisTypes[item.kind].includes(basis.type)) {
            issue(["items", index, "basis", position, "type"], `a ${item.kind} can use only ${allowedBasisTypes[item.kind].join(", ")} as basis`);
          }
        });
        if (new Set(item.basedOn).size !== item.basedOn.length) issue(at("basedOn"), "basedOn must be unique");
        if (item.kind === "fact") {
          if (item.basis.length === 0) issue(at("basis"), "a fact needs at least one basis record; without one it is not a fact");
          if (item.basedOn.length > 0) issue(at("basedOn"), "a fact is not derived from other items");
        } else if (item.basedOn.length === 0) {
          issue(at("basedOn"), `a ${item.kind} must point to the earlier items it is based on`);
        }
        // 仮説は事実を、提案は事実・仮説を根拠にする。先行する項目だけを指せる（循環・前方参照を作らない）。
        const allowedKinds = item.kind === "hypothesis" ? ["fact"] : ["fact", "hypothesis"];
        item.basedOn.forEach((target, position) => {
          const targetItem = input.items[target];
          if (target >= index || targetItem === undefined) {
            issue(["items", index, "basedOn", position], "basedOn must point to an earlier item");
          } else if (item.kind !== "fact" && !allowedKinds.includes(targetItem.kind)) {
            issue(["items", index, "basedOn", position], `a ${item.kind} can be based on ${allowedKinds.join(" or ")} items only`);
          }
        });
        if (item.kind === "hypothesis") {
          if (item.confidence === null) issue(at("confidence"), "confidence is required for a hypothesis");
          if (item.verification === null) issue(at("verification"), "verification (how to confirm or refute it) is required for a hypothesis; a hypothesis is not a causal conclusion");
        } else {
          if (item.confidence !== null) issue(at("confidence"), "confidence is only for a hypothesis");
          if (item.verification !== null) issue(at("verification"), "verification is only for a hypothesis");
        }
      });
    });

export const parseRecordIntentExplanationInput = (input: unknown, now: number): RecordIntentExplanationInput =>
  parseWith(recordIntentExplanationSchema(now), input, "Intent Explanation");
