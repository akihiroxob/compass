import { randomUUID } from "node:crypto";
import { ActivityScope, type ActivityReference } from "../domain/Activity.ts";
import type { NewActivity, ActivityStore } from "./port/ActivityStore.ts";

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
 * canonical Activityにする状態変更と、その種別・要約。業務上の出来事（起票・着手・作業完了・レビュー・差戻し・受入・取消）だけを対象にする。
 * Claimの更新・解放・期限切れ・競合、編集、Reviewer / 受入担当のClaim、期限切れClaimの引き継ぎは実行の追跡（Change Log）であり、
 * 後から経緯を理解するための意味的な出来事ではないため対象外とする。`when`がある種別は、その条件を満たすChangeだけが対象。
 */
const workActivities: Record<
  string,
  { type: string; summary: (title: string) => string; when?: (payload: Record<string, unknown>) => boolean }
> = {
  STORY_CREATED: { type: "story.created", summary: (title) => `Story「${title}」を起票した` },
  STORY_STARTED: { type: "story.started", summary: (title) => `Story「${title}」に着手した` },
  STORY_COMPLETED: { type: "story.completed", summary: (title) => `Story「${title}」が完了した` },
  STORY_CANCELED: { type: "story.canceled", summary: (title) => `Story「${title}」を取り消した` },
  TASK_CREATED: { type: "task.created", summary: (title) => `Task「${title}」を起票した` },
  // Taskの着手は、work Claimの最初の取得（未着手 / 差戻しからの開始）だけ。期限切れClaimの引き継ぎ・Reviewer / 受入のClaimは含めない。
  TASK_CLAIMED: {
    type: "task.started",
    summary: (title) => `Task「${title}」に着手した`,
    when: (payload) => payload.claimCommand === "claim_task" && payload.path === "normal",
  },
  TASK_COMPLETED: { type: "task.completed", summary: (title) => `Task「${title}」の作業を完了し、レビューへ進めた` },
  TASK_REVIEWED: { type: "task.reviewed", summary: (title) => `Task「${title}」のレビューを承認した` },
  TASK_ACCEPTED: { type: "task.accepted", summary: (title) => `Task「${title}」を受け入れた` },
  TASK_REJECTED: { type: "task.rejected", summary: (title) => `Task「${title}」を差し戻した` },
  TASK_CANCELED: { type: "task.canceled", summary: (title) => `Task「${title}」を取り消した` },
};

export const canonicalWorkChangeTypes = Object.keys(workActivities);

/** このChangeをcanonical Activityにするか（種別と、種別ごとの条件）。 */
export const isCanonicalWorkChange = (type: string, payload: Record<string, unknown>): boolean => {
  const definition = workActivities[type];
  return definition !== undefined && (definition.when?.(payload) ?? true);
};

const maximumSummaryTitleLength = 200;

const textOf = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

/**
 * 重要なWorkの状態変更から、canonical Activityの保存値を組み立てる。
 * 生成元のChangeの`cursor`で一意にするため、同じChangeから2件作られない。対象外のChangeでは何もしない。
 */
export const canonicalWorkActivity = (
  change: WorkChangeFact,
  newId: () => string = randomUUID,
): NewActivity | null => {
  const definition = workActivities[change.type];
  if (!definition || !isCanonicalWorkChange(change.type, change.payload)) return null;
  const title =
    change.subject.title.length > maximumSummaryTitleLength
      ? `${change.subject.title.slice(0, maximumSummaryTitleLength)}…`
      : change.subject.title;
  const refs: ActivityReference[] = [{ kind: change.subject.kind, id: change.subject.id }];
  if (change.subject.kind === "task" && change.subject.storyId) refs.push({ kind: "story", id: change.subject.storyId });
  // 差戻し・取消の理由は判断の経緯なので本文に残す。その他の詳細はChange Logを正とし、複製しない。
  const reason = textOf(change.payload.reason);
  return {
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
  };
};

export const recordCanonicalWorkActivity = async (store: ActivityStore, change: WorkChangeFact, newId: () => string = randomUUID): Promise<void> => {
  const activity = canonicalWorkActivity(change, newId);
  if (activity) await store.append(activity);
};
