import { z } from "zod";
import { executionEvidenceKinds } from "../domain/model/OutcomeExecution.ts";
import { parseWith, trimmedText } from "./projectSchema.ts";

/** 完全な40桁のcommit SHAだけを受け付け、大文字小文字を正規化する。短縮SHAは受け付けない。 */
const commitSha = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$/i, "versionHash must be a full 40-character commit SHA")
  .transform((value) => value.toLowerCase());

/**
 * 取得元URI。http(s)のURLだけを受け付け、認証情報（user:password@）を含むURLは拒否する。
 * `URL#href`へ正規化し、表記だけが違う同じURLを別のEvidenceとして重複させない。
 */
const sourceUri = trimmedText("uri", 2_000)
  .refine((value) => URL.canParse(value), { message: "uri must be a valid URL" })
  .refine((value) => !URL.canParse(value) || ["http:", "https:"].includes(new URL(value).protocol), {
    message: "uri must use http or https",
  })
  .refine((value) => !URL.canParse(value) || (new URL(value).username === "" && new URL(value).password === ""), {
    message: "uri must not contain credentials",
  })
  .transform((value) => new URL(value).href);

const evidenceReferenceSchema = z
  .object({
    kind: z.enum(executionEvidenceKinds, { error: `kind must be one of: ${executionEvidenceKinds.join(", ")}` }),
    uri: sourceUri,
    versionHash: commitSha.nullish().transform((value) => value ?? null),
    observedAt: z.number().int().positive("observedAt must be a positive epoch milliseconds value"),
  })
  .superRefine((input, context) => {
    // commitは版そのものを指すため、versionHashを省略できない。
    if (input.kind === "commit" && input.versionHash === null) {
      context.addIssue({ code: "custom", path: ["versionHash"], message: "versionHash is required for a commit" });
    }
  });

export const recordExecutionEvidenceSchema = z.object({
  /** Runtimeが`list_changes`で読んだところまでのChange cursor（`nextCursor`）。 */
  changeCursor: z.number().int("changeCursor must be an integer").min(0, "changeCursor must be 0 or more"),
  evidence: z.array(evidenceReferenceSchema).max(50, "evidence must have 50 items or fewer").default([]),
});

export type RecordExecutionEvidenceInput = z.infer<typeof recordExecutionEvidenceSchema>;

export const parseRecordExecutionEvidenceInput = (input: unknown): RecordExecutionEvidenceInput =>
  parseWith(recordExecutionEvidenceSchema, input, "Execution evidence");
