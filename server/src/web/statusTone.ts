// 状態badgeの意味（Task 04）。色は`styles.css`の`--tone-*`で定義し、各画面は状態をこのtoneへ対応付けるだけにする。
// 色だけに頼らず、badgeには必ず状態のラベル文字を併記する。

/**
 * - attention: 要対応（受入待ち・差戻し・あなたの操作）
 * - waiting: 待機（未着手・Agentの担当待ち）
 * - progress: 進行中（作業中・レビュー待ち・Claim保持中）。Agentの稼働を意味しない
 * - done: 完了（受入済み・評価で達成）
 * - muted: 終了・控えめ（取消・過去の項目・分類ラベル）
 * - warning: 警告（期限切れの再取得待ち等）
 */
export type StatusTone = "attention" | "waiting" | "progress" | "done" | "muted" | "warning";

export const statusBadgeClass = (tone: StatusTone) => `status-badge tone-${tone}`;
