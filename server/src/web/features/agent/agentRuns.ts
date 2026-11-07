// Agentの実行観測（UI-E2）。Ralph・Orchestratorが報告した実行の開始・観測・終了だけから実行状況を決め、
// Grant・Credential・Claimからは推測しない。テストからも読み込むため、型以外をimportしない純関数だけを置く。
import type { StatusTone } from "../../statusTone.ts";

export type AgentRunObservation = "running" | "stale" | "succeeded" | "failed";
export type AgentRunWorkRef = { kind: "task" | "intent" | "outcome" | "evaluation" | "research_request" | "consultation"; id: string };

/** `GET /api/workspaces/:workspaceId/agent-runs`の1件。時刻はServerが報告を受け付けた時刻。 */
export type AgentRun = {
  runId: string;
  scope: { kind: "workspace" | "project"; id: string };
  principalId: string;
  role: string;
  source: "ralph" | "orchestrator";
  provider: string | null;
  workRef: AgentRunWorkRef | null;
  reporter: { kind: "agent" | "runtime"; principalId: string };
  status: "running" | "succeeded" | "failed";
  startedAt: number;
  observedAt: number;
  staleAt: number;
  endedAt: number | null;
  reason: string | null;
  /** Serverの読取時刻（`asOf`）で判定した観測状態。 */
  observation: AgentRunObservation;
};
export type AgentRuns = { asOf: number; runs: AgentRun[] };

export const agentRunsPath = (workspaceId: string, principalId?: string) =>
  `/api/workspaces/${workspaceId}/agent-runs${principalId === undefined ? "" : `?principalId=${encodeURIComponent(principalId)}`}`;

/**
 * Principalの実行状況。
 * - `unavailable`: 実行観測を取得できなかった（取得不能。観測なし・停止とは扱わない）
 * - `none`: 報告が1件も無い（Runner未接続・未起動を含む。不明）
 * - それ以外: 代表のrun（期限内に報告のある実行中を優先し、無ければ最後に報告のあったrun）
 */
export type AgentExecution =
  | { kind: "unavailable"; error: string }
  | { kind: "none" }
  | { kind: AgentRunObservation; run: AgentRun; asOf: number; runningCount: number };

export const agentExecutionOf = (principalId: string, runs: AgentRuns | { error: string }): AgentExecution => {
  if ("error" in runs) return { kind: "unavailable", error: runs.error };
  const own = runs.runs.filter((run) => run.principalId === principalId);
  if (own.length === 0) return { kind: "none" };
  const running = own.filter((run) => run.observation === "running").sort((a, b) => b.observedAt - a.observedAt);
  const latest = [...own].sort((a, b) => b.observedAt - a.observedAt)[0];
  const run = running[0] ?? latest;
  return { kind: run.observation, run, asOf: runs.asOf, runningCount: running.length };
};

/** 一覧・詳細のbadge。観測途絶・観測なし・取得不能は稼働中とせず、いずれも「不明」系で区別する。 */
export const agentExecutionLabels: Record<AgentExecution["kind"], string> = {
  running: "作業中",
  succeeded: "待機",
  failed: "エラー",
  stale: "不明（観測途絶）",
  none: "不明（観測なし）",
  unavailable: "取得不能",
};
export const agentExecutionTones: Record<AgentExecution["kind"], StatusTone> = {
  running: "progress",
  succeeded: "waiting",
  failed: "attention",
  stale: "warning",
  none: "muted",
  unavailable: "warning",
};
export const agentRunObservationLabels: Record<AgentRunObservation, string> = {
  running: "実行中",
  stale: "観測途絶",
  succeeded: "正常終了",
  failed: "異常終了",
};

/** 経過時間の短い表示（分・時間・日）。 */
export const formatElapsed = (ms: number): string => {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 1) return "1分未満";
  if (minutes < 60) return `${minutes}分`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 === 0 ? `${hours}時間` : `${hours}時間${minutes % 60}分`;
  return `${Math.floor(hours / 24)}日`;
};

/** 実行状況の理由文。観測時刻の表示は呼出側の`formatTime`を使う。 */
export const agentExecutionReason = (execution: AgentExecution, formatTime: (value: number) => string): string => {
  switch (execution.kind) {
    case "unavailable":
      return `実行観測を取得できませんでした（${execution.error}）。稼働・停止は判断していません。`;
    case "none":
      return "実行の報告がありません。Ralph・Orchestratorが未接続・未起動の可能性があり、稼働・停止は判断していません。";
    case "running":
      return `${formatTime(execution.run.startedAt)}開始。最終観測 ${formatTime(execution.run.observedAt)}${execution.runningCount > 1 ? `（実行中の報告${execution.runningCount}件）` : ""}`;
    case "stale":
      return `最終観測 ${formatTime(execution.run.observedAt)}から${formatElapsed(execution.asOf - execution.run.observedAt)}報告がありません。稼働中とは断定しません。`;
    case "succeeded":
      return `前回の実行は${formatTime(execution.run.endedAt ?? execution.run.observedAt)}に正常終了。その後の実行は報告されていません。`;
    case "failed":
      return `${formatTime(execution.run.endedAt ?? execution.run.observedAt)}に異常終了: ${execution.run.reason ?? "終了理由の報告なし"}`;
  }
};

export const agentRunSourceLabels: Record<AgentRun["source"], string> = { ralph: "Ralph", orchestrator: "Orchestrator" };
export const agentRunWorkKindLabels: Record<AgentRunWorkRef["kind"], string> = {
  task: "Task",
  intent: "Intent",
  outcome: "Outcome",
  evaluation: "Evaluation",
  research_request: "Research",
  consultation: "相談",
};
