import { z } from "zod";
import { parseWith, trimmedText } from "./projectSchema.ts";

const idText = trimmedText("id", 200);
/** transportの再送を同じ操作として扱うためのkey。同じkeyで異なる内容を送った場合は競合になる。 */
const requestKey = trimmedText("requestKey", 200);
/** 依頼とその完了結果を1つの往復として結び付けるid。Wachaへの依頼と、Compassへ戻る参照の両方で同じ値を使う。 */
const correlationId = trimmedText("correlationId", 200);

/**
 * ProjectのRepository内の相対path。Compass serverのローカルfilesystem pathとして扱わないため、
 * 絶対path（先頭が`/`、Windowsドライブレター）とpath traversal（`..`セグメント）を拒否する。
 */
const repositoryRelativePath = trimmedText("path", 1_000).refine(
  (value) =>
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !value.split(/[\\/]+/).some((segment) => segment === ".."),
  { message: "must be a relative path inside the Repository, without a leading slash or .. segments" },
);

/** 短縮SHAを許さず、Git（SHA-1）の完全な40桁16進数だけを受け付ける。 */
const fullCommitSha = z
  .string()
  .trim()
  .regex(/^[0-9a-f]{40}$/i, "must be a full 40-character commit SHA");

const httpUrl = (label: string) =>
  z
    .url(`${label} must be a valid URL`)
    .refine((value) => value.startsWith("http://") || value.startsWith("https://"), {
      message: `${label} must use http or https`,
    });

export const createAdrHandoffRequestSchema = z.object({
  decisionId: idText,
  repositoryId: idText,
  correlationId,
  requestKey,
});

export type CreateAdrHandoffRequestInput = z.infer<typeof createAdrHandoffRequestSchema>;

export const recordAdrReferenceSchema = z.object({
  decisionId: idText,
  repositoryId: idText,
  path: repositoryRelativePath,
  commitSha: fullCommitSha,
  pullRequestUrl: httpUrl("pullRequestUrl").nullable().optional().transform((value) => value ?? null),
  correlationId,
  requestKey,
});

export type RecordAdrReferenceInput = z.infer<typeof recordAdrReferenceSchema>;

export const parseCreateAdrHandoffRequestInput = (input: unknown): CreateAdrHandoffRequestInput =>
  parseWith(createAdrHandoffRequestSchema, input, "ADR Handoff Request");

export const parseRecordAdrReferenceInput = (input: unknown): RecordAdrReferenceInput =>
  parseWith(recordAdrReferenceSchema, input, "ADR Reference");
