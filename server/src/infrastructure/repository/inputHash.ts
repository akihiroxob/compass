import { createHash } from "node:crypto";

const canonicalize = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
};

/**
 * 検証済み入力の内容hash。項目の並び順に依存しない。同じrequestKeyの再送が「同じ内容」かを判定するために保存し、
 * 内容が異なる再利用（transport再送ではない別操作）を拒否する。
 */
export const inputHash = (input: unknown): string =>
  createHash("sha256").update(JSON.stringify(canonicalize(input))).digest("hex");
