import type { Generated } from "kysely";
import type {
  ChangeRecord,
  CommandReceiptRecord,
  StoryRecord,
  TaskClaimRecord,
  TaskCommentRecord,
  TaskRecord,
} from "../application/port/WorkStore.ts";

/** 列の定義は`WorkStore`のrecordと同じ。`change_log.cursor`だけDBが採番する。 */
export type StoryTable = StoryRecord;
export type TaskTable = TaskRecord;
export type TaskCommentTable = TaskCommentRecord;
export type TaskClaimTable = TaskClaimRecord;
export type ChangeLogTable = Omit<ChangeRecord, "cursor"> & { cursor: Generated<number> };
export type CommandReceiptTable = CommandReceiptRecord;

/** Workが所有するtable。単一SQLite fileの一部で、serverが他Contextのtableと合成する。 */
export type WorkDatabase = {
  story: StoryTable;
  task: TaskTable;
  task_comment: TaskCommentTable;
  task_claim: TaskClaimTable;
  change_log: ChangeLogTable;
  command_receipt: CommandReceiptTable;
};
