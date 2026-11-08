// Workspace一覧の各Workspaceの比較情報（問題・対応待ち）の集計。取得できない・対象が無い・問題が無いを区別する純関数。
// テストからも読み込むため、型と純関数のmodule以外をimportしない。
import type { OutcomeOverview, OutcomeOverviewPage, OutcomeProblemFact } from "../outcome/model.ts";
import { inboxApiPath, type InboxPage } from "../consultation/model.ts";

/**
 * Workspaceの問題。Outcomeの止まっている問題（Outcomeに関わる相談）をWorkspace全体で数える。
 * - `unknown`: 取得できなかった（問題なしではない）
 * - `no_outcomes`: Outcomeが無く、判定の対象が無い（問題なしとは言わない）
 * - `none`: 全Outcomeを確認し、止まっている問題は無い
 * 代表は待ち時間の長いHuman待ちを優先し、残りは`otherCount`。一部のOutcomeの問題を確認できないときは`unconfirmed`、
 * Outcomeが多く一部しか読めていないときは`truncated`で示す。
 */
export type WorkspaceProblems =
  | { state: "unknown" }
  | { state: "no_outcomes" }
  | { state: "none" }
  | { state: "present"; representative: OutcomeProblemFact; otherCount: number; unconfirmed: number; truncated: boolean };

const compareProblems = (left: OutcomeProblemFact, right: OutcomeProblemFact) =>
  (left.kind === right.kind ? 0 : left.kind === "waiting_human" ? -1 : 1) ||
  left.updatedAt - right.updatedAt ||
  (left.consultationId < right.consultationId ? -1 : 1);

/** Outcome一覧の1ページ（Workspace全体の先頭`workspaceTotal`件以内）から、Workspaceの問題を求める。ページを取得できなければnull。 */
export const summarizeWorkspaceProblems = (page: Pick<OutcomeOverviewPage, "items" | "workspaceTotal"> | null): WorkspaceProblems => {
  if (page === null) return { state: "unknown" };
  if (page.workspaceTotal === 0) return { state: "no_outcomes" };
  const items: OutcomeOverview[] = page.items;
  const truncated = items.length < page.workspaceTotal;
  const unconfirmed = items.filter(({ problems }) => problems.state === "unknown").length;
  // 同じ相談が複数のOutcomeに関わっても1件。同一性は相談IDだけで決める。
  const facts = [...new Map(items.flatMap(({ problems }) => (problems.state === "present" ? problems.items : [])).map((fact) => [fact.consultationId, fact])).values()].sort(compareProblems);
  const [representative] = facts;
  if (representative) return { state: "present", representative, otherCount: facts.length - 1, unconfirmed, truncated };
  // 問題を確認できたOutcomeが無い（全て未取得・または一部しか読めていない）ときは、問題なしと言わない。
  return unconfirmed > 0 || truncated ? { state: "unknown" } : { state: "none" };
};

/** Human待ちの相談の件数。`more`は上限を超えて続きがあること（正確な件数ではない）。 */
export type WaitingCount = { state: "unknown" } | { state: "counted"; count: number; more: boolean };

/** 1回に読む上限（serverの最大）。 */
export const waitingCountLimit = 100;

export const summarizeWaiting = (page: Pick<InboxPage, "consultations" | "nextCursor"> | null): WaitingCount =>
  page === null ? { state: "unknown" } : { state: "counted", count: page.consultations.length, more: page.nextCursor !== null };

/** 対応待ち（Humanの判断待ち）の件数を読むAPI path。Workspaceと配下Projectの相談を対象にする。 */
export const waitingCountPath = (workspaceId: string): string =>
  `${inboxApiPath({ status: "waiting_human", scope: "all", projectId: null, workspaceId })}&limit=${waitingCountLimit}`;

export const waitingCountText = (waiting: WaitingCount): string => (waiting.state === "unknown" ? "—" : `${waiting.count}${waiting.more ? "+" : ""}`);
