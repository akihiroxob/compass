import { randomUUID } from "node:crypto";
import { ActivityScope, type ActivityReference } from "../domain/Activity.ts";
import type { ActivityStore } from "./port/ActivityStore.ts";

/**
 * Workの状態変更（Change Log 1件）。ActivityはWorkに依存しないため、serverがWorkのChangeからこの形へ変換して渡す。
 * `subject`は変更対象のStory / Task（同じtransactionで読んだ値）。
 */
export type WorkChangeFact = {
  cursor: number;
  workspaceId: string;
  projectId: string;
  type: string;
  principalId: string;
  payload: Record<string, unknown>;
  occurredAt: number;
  subject: { kind: "story" | "task"; id: string; title: string; storyId: string | null };
};

/**
 * canonical Activityにする状態変更と、その種別・要約。Claimの取得・更新・期限切れ、編集、Storyの着手は
 * 実行の追跡（Change Log）であり、後から経緯を理解するための意味的な出来事ではないため対象外とする。
 */
const workActivities: Record<string, { type: string; summary: (title: string) => string }> = {
  STORY_CREATED: { type: "story.created", summary: (title) => `Story「${title}」を起票した` },
  STORY_COMPLETED: { type: "story.completed", summary: (title) => `Story「${title}」が完了した` },
  STORY_CANCELED: { type: "story.canceled", summary: (title) => `Story「${title}」を取り消した` },
  TASK_CREATED: { type: "task.created", summary: (title) => `Task「${title}」を起票した` },
  TASK_COMPLETED: { type: "task.completed", summary: (title) => `Task「${title}」の作業を完了し、レビューへ進めた` },
  TASK_REVIEWED: { type: "task.reviewed", summary: (title) => `Task「${title}」のレビューを承認した` },
  TASK_ACCEPTED: { type: "task.accepted", summary: (title) => `Task「${title}」を受け入れた` },
  TASK_REJECTED: { type: "task.rejected", summary: (title) => `Task「${title}」を差し戻した` },
  TASK_CANCELED: { type: "task.canceled", summary: (title) => `Task「${title}」を取り消した` },
};

export const canonicalWorkChangeTypes = Object.keys(workActivities);

const maximumSummaryTitleLength = 200;

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * 重要なWorkの状態変更から、canonical Activityを追記する。状態変更と同じtransactionのstoreで呼ぶ。
 * 生成元のChangeの`cursor`で一意にするため、同じChangeから2件作られない。対象外のChangeでは何もしない。
 */
export const recordCanonicalWorkActivity = async (
  store: ActivityStore,
  change: WorkChangeFact,
  newId: () => string = randomUUID,
): Promise<void> => {
  const definition = workActivities[change.type];
  if (!definition) return;
  const title =
    change.subject.title.length > maximumSummaryTitleLength
      ? `${change.subject.title.slice(0, maximumSummaryTitleLength)}…`
      : change.subject.title;
  const refs: ActivityReference[] = [{ kind: change.subject.kind, id: change.subject.id }];
  if (change.subject.kind === "task" && change.subject.storyId) refs.push({ kind: "story", id: change.subject.storyId });
  // 差戻し・取消の理由は判断の経緯なので本文に残す。その他の詳細はChange Logを正とし、複製しない。
  const reason = textOf(change.payload.reason);
  await store.append({
    id: newId(),
    scope: ActivityScope.PROJECT,
    workspaceId: change.workspaceId,
    projectId: change.projectId,
    type: definition.type,
    principalId: change.principalId,
    role: textOf(change.payload.actorRole) ?? "system",
    summary: definition.summary(title),
    body: reason ? `理由: ${reason}` : null,
    refs,
    correctsActivityId: null,
    source: "canonical",
    occurredAt: change.occurredAt,
    recordedAt: change.occurredAt,
    dedupeKey: `work_change:${change.cursor}`,
    inputHash: null,
  });
};
