import type { Generated } from "kysely";

/**
 * Activityが所有するtable。単一SQLite fileの一部で、serverが他Contextのtableと合成する。
 * `refs`はJSON配列。`dedupe_key`で再送・二重生成を1件に収束させる。
 */
export type ActivityTable = {
  cursor: Generated<number>;
  id: string;
  scope: string;
  project_id: string | null;
  type: string;
  principal_id: string;
  role: string;
  summary: string;
  body: string | null;
  refs: string;
  corrects_activity_id: string | null;
  source: string;
  dedupe_key: string;
  input_hash: string | null;
  occurred_at: number;
  recorded_at: number;
};

export type ActivityDatabase = {
  activity: ActivityTable;
};
