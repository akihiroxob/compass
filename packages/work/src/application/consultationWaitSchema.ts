import { createHash } from "node:crypto";
import { z } from "zod";
import type { StoryRecord, TaskRecord } from "./port/WorkStore.ts";

export const consultationRuntimeSchema = z.strictObject({
  worktreePath: z.string().min(1),
  contextPath: z.string().min(1),
  headSha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 未commit変更・未追跡成果物を含むRuntime側のfingerprint。 */
  sourceFingerprint: z.string().min(1),
  pullRequest: z.string().nullable(),
  verificationRefs: z.array(z.string()),
});

export const waitForConsultationsSchema = z.strictObject({
  taskId: z.string().min(1),
  claimId: z.string().min(1),
  consultationIds: z.array(z.string().min(1)).min(1).max(30),
  reason: z.string().trim().min(1),
  runtime: consultationRuntimeSchema,
});

export type ConsultationWaitReference = { id: string; revision: number; resolutionId: string | null; confirmedCancellation?: string };

/** sortOrderや待機状態の更新では版を変えず、現在の要件・段階・Story snapshotを照合する。 */
export const taskRequirementVersion = (task: TaskRecord, story: StoryRecord | null) => createHash("sha256").update(JSON.stringify({
  title: task.title, description: task.description, status: task.status, rejectReason: task.reject_reason,
  story: story && { title: story.title, description: story.description, status: story.status,
    successCriteria: story.success_criteria_snapshot, constraints: story.constraints_snapshot, repository: story.repository_snapshot },
})).digest("hex");
