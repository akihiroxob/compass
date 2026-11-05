import { z } from "zod";
import { optionalText, parseWith, trimmedText } from "@compass/shared";
import { addCalendarDays, calendarDaysBetween, intentMetricObservationStatuses, utcCalendarDate } from "../domain/IntentMetric.ts";
import type { DefineIntentMetricInput, IntentMetricObservationInput, IntentMetricSeriesRange } from "../domain/IntentMetricRepository.ts";

/** 暦日として存在する`YYYY-MM-DD`か。時刻・タイムゾーンは持たない。 */
const isCalendarDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
};

const calendarDate = (label: string) =>
  z.string().trim().refine(isCalendarDate, `${label} must be a calendar date in YYYY-MM-DD format`);

/** JSONで表せる有限の数値。文字列の数値・NaN・Infinityは受け付けない。 */
const finiteNumber = (label: string) =>
  z.number({ error: `${label} must be a number` }).refine(Number.isFinite, `${label} must be a finite number`);

/** 出所の参照先。http(s)だけを受け付け、認証情報を含むURLは拒否して`URL#href`へ正規化する。 */
const sourceUri = trimmedText("source.uri", 2_000)
  .refine((value) => URL.canParse(value), { message: "source.uri must be a valid URL" })
  .refine((value) => !URL.canParse(value) || ["http:", "https:"].includes(new URL(value).protocol), {
    message: "source.uri must use http or https",
  })
  .refine((value) => !URL.canParse(value) || (new URL(value).username === "" && new URL(value).password === ""), {
    message: "source.uri must not contain credentials",
  })
  .transform((value) => new URL(value).href);

/** 対象期間の最大日数（両端を含む）。 */
const maximumPeriodDays = 366;
/** 観測時刻の未来方向の許容（時計のずれ）。 */
const clockSkewMilliseconds = 5 * 60_000;
/** Dateで表せる最大のepoch milliseconds。超える値はDate変換前に拒否する。 */
const maximumEpochMilliseconds = 8_640_000_000_000_000;
/** 1回に記録できる観測値の件数。 */
const maximumObservations = 100;
/** 時系列の取得範囲の既定（日数）と上限。 */
const defaultRangeDays = 30;
const maximumRangeDays = 366;

/**
 * 観測項目の定義。keyはIntent内で一意な識別子（英小文字・数字・`_`・`-`・`.`、64文字まで）。
 * 目標値は任意の有限数で、Intentの説明文から生成しない。staleAfterDaysは1〜366の整数。
 */
export const defineIntentMetricSchema = z.object({
  key: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9_.-]{0,63}$/, "key must be 1-64 characters of a-z, 0-9, _, - or . starting with a letter or digit"),
  name: trimmedText("name", 100),
  unit: trimmedText("unit", 30),
  targetValue: finiteNumber("targetValue").nullish().transform((value) => value ?? null),
  staleAfterDays: z
    .number({ error: "staleAfterDays must be a number" })
    .int("staleAfterDays must be an integer")
    .min(1, "staleAfterDays must be 1 or more")
    .max(366, "staleAfterDays must be 366 or less"),
});

const observationSchema = (now: number) =>
  z
    .object({
      periodStart: calendarDate("periodStart"),
      periodEnd: calendarDate("periodEnd"),
      status: z.enum(intentMetricObservationStatuses, {
        error: `status must be one of: ${intentMetricObservationStatuses.join(", ")}`,
      }),
      value: finiteNumber("value").nullish().transform((value) => value ?? null),
      failureReason: optionalText(2_000),
      source: z.object({
        name: trimmedText("source.name", 200),
        uri: sourceUri.nullish().transform((value) => value ?? null),
      }),
      observedAt: z
        .number({ error: "observedAt must be epoch milliseconds" })
        .int("observedAt must be an integer epoch milliseconds value")
        .positive("observedAt must be a positive epoch milliseconds value")
        .max(maximumEpochMilliseconds, "observedAt is out of the supported time range"),
    })
    .superRefine((input, context) => {
      const issue = (path: string, message: string) => context.addIssue({ code: "custom", path: [path], message });
      // 取得できた値と取得失敗を混ぜない。失敗にゼロ等の代替値を入れさせない。
      if (input.status === "observed") {
        if (input.value === null) issue("value", "value is required when status is observed");
        if (input.failureReason !== null) issue("failureReason", "failureReason is only for status failed");
      } else {
        if (input.value !== null) issue("value", "value must be omitted when status is failed; do not substitute zero or an estimate");
        if (input.failureReason === null) issue("failureReason", "failureReason is required when status is failed");
      }
      if (!isCalendarDate(input.periodStart) || !isCalendarDate(input.periodEnd)) return;
      const days = calendarDaysBetween(input.periodStart, input.periodEnd);
      if (days < 0) issue("periodEnd", "periodEnd must not be before periodStart");
      else if (days + 1 > maximumPeriodDays) issue("periodEnd", `the period must be ${maximumPeriodDays} days or shorter`);
      if (input.observedAt > now + clockSkewMilliseconds) {
        issue("observedAt", "observedAt must not be in the future");
        return;
      }
      // 対象期間が始まる前に観測したことにしない。タイムゾーン差として1日だけ許容する（UTCの暦日で比較）。
      if (input.periodStart > addCalendarDays(utcCalendarDate(input.observedAt), 1)) {
        issue("periodStart", "the period must have started by observedAt");
      }
    });

/** 1回の記録。同じ対象期間を同じ要求の中で重複させない。 */
export const recordIntentMetricObservationsSchema = (now: number) =>
  z.object({
    metricKey: trimmedText("metricKey", 64),
    observations: z
      .array(observationSchema(now))
      .min(1, "observations must have at least 1 item")
      .max(maximumObservations, `observations must have ${maximumObservations} items or fewer`)
      .superRefine((observations, context) => {
        const seen = new Set<string>();
        observations.forEach((observation, index) => {
          const period = `${observation.periodStart}/${observation.periodEnd}`;
          if (seen.has(period)) {
            context.addIssue({ code: "custom", path: [index, "periodStart"], message: `period ${period} appears more than once` });
          }
          seen.add(period);
        });
      }),
  });

/** 時系列の取得範囲。未指定のtoは今日（UTC）、fromはtoから30日分。範囲は366日まで。 */
export const intentMetricSeriesRangeSchema = (now: number) =>
  z
    .object({
      from: calendarDate("from").optional(),
      to: calendarDate("to").optional(),
    })
    .transform((input) => {
      const to = input.to ?? utcCalendarDate(now);
      return { from: input.from ?? addCalendarDays(to, -(defaultRangeDays - 1)), to };
    })
    .superRefine((range, context) => {
      const days = calendarDaysBetween(range.from, range.to);
      if (days < 0) context.addIssue({ code: "custom", path: ["from"], message: "from must not be after to" });
      else if (days + 1 > maximumRangeDays) {
        context.addIssue({ code: "custom", path: ["from"], message: `the range must be ${maximumRangeDays} days or shorter` });
      }
    });

export type RecordIntentMetricObservationsInput = { metricKey: string; observations: IntentMetricObservationInput[] };

export const parseDefineIntentMetricInput = (input: unknown): DefineIntentMetricInput =>
  parseWith(defineIntentMetricSchema, input, "Intent Metric");

export const parseRecordIntentMetricObservationsInput = (input: unknown, now: number): RecordIntentMetricObservationsInput =>
  parseWith(recordIntentMetricObservationsSchema(now), input, "Intent Metric observations");

export const parseIntentMetricSeriesRange = (input: unknown, now: number): IntentMetricSeriesRange =>
  parseWith(intentMetricSeriesRangeSchema(now), input ?? {}, "Intent Metric range");
