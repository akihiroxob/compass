import { z } from "zod";
import { optionalText, parseWith, trimmedText } from "@compass/direction";

/** Human operatorのTask介入（Task 46）の入力。理由・本文は前後の空白を除いて必須。 */
export const taskReasonSchema = z.object({ reason: trimmedText("reason", 2_000) });
export const taskCommentSchema = z.object({ body: trimmedText("body", 10_000) });

export const parseTaskReasonInput = (input: unknown) => parseWith(taskReasonSchema, input, "Task");
export const parseTaskCommentInput = (input: unknown) => parseWith(taskCommentSchema, input, "Comment");

/**
 * Human手動起票（Task 47。U4）のStory・Task入力。titleは必須、descriptionは空なら未設定（`null`）。
 * Outcomeの相関ID・`taskKey`は受け付けない（Outcome handoffはManagerの`issue_story` / `issue_task`だけが作る）。
 */
const executionItemShape = { title: trimmedText("title", 200), description: optionalText(10_000) };
export const storyInputSchema = z.object(executionItemShape).strict();
/** `storyId`は空・未指定ならStoryに属さないTask。編集では対象Storyを変えない（`storyId`を受け付けない）。 */
export const createTaskInputSchema = z
  .object({ ...executionItemShape, storyId: z.string().trim().nullable().optional().transform((value) => value || null) })
  .strict();
export const editTaskInputSchema = z.object(executionItemShape).strict();

export type ExecutionItemInput = z.infer<typeof storyInputSchema>;
export type CreateTaskInput = z.infer<typeof createTaskInputSchema>;

export const parseStoryInput = (input: unknown): ExecutionItemInput => parseWith(storyInputSchema, input, "Story");
export const parseCreateTaskInput = (input: unknown): CreateTaskInput => parseWith(createTaskInputSchema, input, "Task");
export const parseEditTaskInput = (input: unknown): ExecutionItemInput => parseWith(editTaskInputSchema, input, "Task");
