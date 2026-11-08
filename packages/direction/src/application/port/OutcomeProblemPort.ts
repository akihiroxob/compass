import type { OutcomeProjectRef } from "./ExecutionSummaryPort.ts";

/**
 * 開発を止めている問題。Human待ち（`waiting_human`の相談）とAgentが対処する問題（`waiting_agent`の相談）を区別する。
 * 問題の同一性は相談IDで決め、題名・理由の文章一致では決めない。同じ相談が複数のProject・Taskに関わっても1件に数える。
 */
export type OutcomeProblemKind = "waiting_human" | "waiting_agent";

export type OutcomeProblemFact = {
  consultationId: string;
  kind: OutcomeProblemKind;
  scope: "project" | "workspace";
  /** 相談の題名。 */
  title: string;
  /** これが決まらないと進めない理由（代表の理由）。 */
  reason: string;
  /** 相談が止めているTarget Project。Workspace scopeの相談は空。 */
  projectIds: string[];
  /** 相談を待っているTask。 */
  taskIds: string[];
  updatedAt: number;
};

/** OutcomeごとのProject問題。Outcomeに問題が無ければ`problems`は空配列。 */
export type OutcomeProblemFacts = { outcomeId: string; problems: OutcomeProblemFact[] };

/**
 * Direction → Collaboration・Workの読取専用ポート。Outcomeに相関付いたTaskが待つ相談と、Outcomeを参照するWorkspace相談を返す。
 * 取得に失敗した場合は例外を投げ、呼び出し側は「問題なし」ではなく「未取得」として扱う。
 */
export interface OutcomeProblemPort {
  listOutcomeProblems(workspaceId: string, outcomeIds: string[], refs: OutcomeProjectRef[]): Promise<OutcomeProblemFacts[]>;
}
