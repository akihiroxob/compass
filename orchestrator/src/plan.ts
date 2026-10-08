import { createHash } from "node:crypto";
import type { OrchestrationOutcome, OrchestrationState } from "./state.ts";

/** Orchestrator が起動する専門 Role。Role 名と値は Compass の Grant と同じ。 */
export type DispatchRole = "strategist" | "researcher" | "manager" | "evaluator";

export const dispatchRoles: readonly DispatchRole[] = ["strategist", "researcher", "manager", "evaluator"];

export type DispatchSubject = { kind: "intent" | "evaluation" | "research_request" | "outcome"; id: string };

/**
 * 現在状態から導いた「この Role をこの対象で起動する」という1件。`key` は Project・対象・状態から決定的に決まり（Project ID で始まる）、
 * 同じ状態からは同じ key になる。起動の重複抑止（並行・再起動・再試行）はこの key で行う。
 */
export type Dispatch = {
  key: string;
  projectId: string;
  role: DispatchRole;
  subject: DispatchSubject;
  /** 起動理由の要約。Operational Log と起動する Role への手掛かりに使い、判断内容は含めない。 */
  reason: string;
};

const openResearchStatuses = new Set(["requested", "running"]);

/** 最新 Evaluation が Direction Decision の根拠になった Outcome は、Strategist の判断で次へ進んだもの。 */
const isDecided = (outcome: OrchestrationOutcome) => outcome.latestEvaluation?.decisionId != null;

/** Strategist が既に判断し、Execution・Evaluation が進行中の Outcome。 */
const isLive = (outcome: OrchestrationOutcome) => outcome.status === "active" && !isDecided(outcome);

const fingerprint = (parts: string[]) => createHash("sha256").update([...parts].sort().join("\n")).digest("hex").slice(0, 16);

/**
 * 明示的な状態判定だけを行い、起動すべき Role を返す。Outcome の内容・調査方法・分解方法などの知的判断は含めない。
 *
 * - 未終了の Research Request → researcher
 * - 判断待ちの最新 Evaluation → strategist
 * - Story / Task の無い Outcome（未分解）→ manager
 * - 全 Target Project から還流し incomplete が無く（`evaluability.status === "evaluable"`）、この Project の還流 cursor で
 *   未評価の Outcome → evaluator。一部の Project の完了だけでは起動しない
 * - 上記のいずれも無い Active Intent（進行中の Outcome・未終了の Research・判断待ちの Evaluation が無い）→ strategist。
 *   Research の要否は起動された Strategist が判断する
 */
export const planDispatches = (state: OrchestrationState): Dispatch[] => {
  if (state.project.status !== "active") return [];
  const projectId = state.project.id;
  const dispatches: Dispatch[] = [];

  for (const request of state.openResearchRequests) {
    dispatches.push({
      key: `${projectId}:researcher:research_request:${request.id}`,
      projectId,
      role: "researcher",
      subject: { kind: "research_request", id: request.id },
      reason: `Research Request is ${request.status}`,
    });
  }

  const intent = state.activeIntent;
  if (!intent) return dispatches;

  let pendingEvaluation = false;
  for (const outcome of state.outcomes) {
    const evaluation = outcome.latestEvaluation;
    if (outcome.status !== "cancelled" && evaluation && evaluation.decisionId === null) {
      pendingEvaluation = true;
      dispatches.push({
        key: `${projectId}:strategist:evaluation:${evaluation.id}`,
        projectId,
        role: "strategist",
        subject: { kind: "evaluation", id: evaluation.id },
        reason: `Outcome ${outcome.id} has an Evaluation awaiting a Direction Decision`,
      });
    }
    if (!isLive(outcome)) continue;
    if (outcome.work === null || outcome.work.taskCount === 0) {
      dispatches.push({
        key: `${projectId}:manager:outcome:${outcome.id}`,
        projectId,
        role: "manager",
        subject: { kind: "outcome", id: outcome.id },
        reason: outcome.work === null ? "Outcome has no Story" : "Outcome's Stories have no Task",
      });
      continue;
    }
    const execution = outcome.execution;
    if (
      execution &&
      outcome.evaluability.status === "evaluable" &&
      (evaluation === null || evaluation.executionCursor < execution.executionCursor)
    ) {
      dispatches.push({
        key: `${projectId}:evaluator:outcome:${outcome.id}:${execution.executionCursor}`,
        projectId,
        role: "evaluator",
        subject: { kind: "outcome", id: outcome.id },
        reason: `Execution is ${execution.state} at cursor ${execution.executionCursor} and not evaluated`,
      });
    }
  }

  const intentResearchOpen = state.intentResearchRequests.some((request) => openResearchStatuses.has(request.status));
  const liveOutcome = state.outcomes.some(isLive);
  if (!pendingEvaluation && !intentResearchOpen && !liveOutcome) {
    // 同じ状態では同じ key になり、Strategist が何も変えずに終えても再起動しない。状態が変われば新しい key になる。
    const version = fingerprint([
      ...state.outcomes.map((outcome) => `outcome:${outcome.id}:${outcome.status}:${outcome.latestEvaluation?.id ?? ""}`),
      ...state.intentResearchRequests.map((request) => `research:${request.id}:${request.status}`),
    ]);
    dispatches.push({
      key: `${projectId}:strategist:intent:${intent.id}:${version}`,
      projectId,
      role: "strategist",
      subject: { kind: "intent", id: intent.id },
      reason:
        state.outcomes.length === 0 && state.intentResearchRequests.length === 0
          ? "Active Intent has no Outcome or Research yet"
          : "Active Intent has no Outcome in progress, open Research or pending Evaluation",
    });
  }
  return dispatches;
};
