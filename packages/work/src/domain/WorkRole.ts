/** Workの操作が要求するAgent Role。Role名と値はAccessのGrantと同じ（`manager`の名前は維持する）。 */
export const WorkRole = {
  /** Story・Taskの作成・編集・取消と最終受入を担う。 */
  MANAGER: "manager",
  /** Taskをclaimして作業し、レビュー可能な状態へ進める。 */
  WORKER: "worker",
  /** 実装レビュー。 */
  REVIEWER: "reviewer",
} as const;

export type WorkRole = (typeof WorkRole)[keyof typeof WorkRole];
