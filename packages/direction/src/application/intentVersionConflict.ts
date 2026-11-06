import { ConflictError } from "@compass/shared";

/**
 * 呼び出し側の版が現在版と異なる。古い編集画面・古い版の判断を現在版の成果として扱わないため、更新せずに現在版を返す。
 * 呼び出し側は現在のIntentを読み直し、内容を確認してから現在版を`expectedVersion`にして再実行する。
 */
export const versionConflict = (intentId: string, currentVersion: number): ConflictError =>
  new ConflictError(
    `Intent ${intentId} is at version ${currentVersion}, which differs from the version the request was based on; ` +
      "reload the Intent and review the current content before retrying",
    { conflict: "intent_version", currentVersion: String(currentVersion) },
  );
