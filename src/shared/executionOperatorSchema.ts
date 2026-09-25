import { z } from "zod";
import { parseWith, trimmedText } from "./projectSchema.ts";

/** Human operatorのTask介入（Task 46）の入力。理由・本文は前後の空白を除いて必須。 */
export const taskReasonSchema = z.object({ reason: trimmedText("reason", 2_000) });
export const taskCommentSchema = z.object({ body: trimmedText("body", 10_000) });

export const parseTaskReasonInput = (input: unknown) => parseWith(taskReasonSchema, input, "Task");
export const parseTaskCommentInput = (input: unknown) => parseWith(taskCommentSchema, input, "Comment");
