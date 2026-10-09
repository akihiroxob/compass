import { createHash } from "node:crypto";
import type { OrchestrationResearchRequest, WorkspaceOrchestrationOutcome, WorkspaceOrchestrationState } from "./state.ts";

/** Orchestrator が起動する専門 Role。Role 名と値は Compass の Grant と同じ。 */
export type DispatchRole = "strategist" | "researcher" | "manager" | "evaluator";

export const dispatchRoles: readonly DispatchRole[] = ["strategist", "researcher", "manager", "evaluator"];

export type DispatchSubject = { kind: "intent" | "evaluation" | "research_request" | "outcome"; id: string };

const openResearchStatuses = new Set(["requested", "running"]);

type OutcomeProgress = { id: string; status: string; latestEvaluation: { id: string; decisionId: string | null } | null };

/** 最新 Evaluation が Direction Decision の根拠になった Outcome は、Strategist の判断で次へ進んだもの。 */
const isDecided = (outcome: OutcomeProgress) => outcome.latestEvaluation?.decisionId != null;

/** Strategist が既に判断し、Execution・Evaluation が進行中の Outcome。 */
const isLive = (outcome: OutcomeProgress) => outcome.status === "active" && !isDecided(outcome);

/** 判断待ち（Direction Decision の根拠になっていない）の最新 Evaluation。取消済みの Outcome は対象外。 */
const pendingEvaluationOf = (outcome: OutcomeProgress) =>
  outcome.status !== "cancelled" && outcome.latestEvaluation && outcome.latestEvaluation.decisionId === null ? outcome.latestEvaluation : null;

const fingerprint = (parts: string[]) => createHash("sha256").update([...parts].sort().join("\n")).digest("hex").slice(0, 16);

/**
 * 進行中の Outcome・未終了の Research・判断待ちの Evaluation が無い Active Intent を Strategist へ渡すときの key の版と理由。
 * 同じ状態では同じ版になり、Strategist が何も変えずに終えても再起動しない。状態が変われば新しい版になる。
 */
const intentStrategistOf = (outcomes: readonly OutcomeProgress[], intentResearchRequests: readonly OrchestrationResearchRequest[]) => ({
  version: fingerprint([
    ...outcomes.map((outcome) => `outcome:${outcome.id}:${outcome.status}:${outcome.latestEvaluation?.id ?? ""}`),
    ...intentResearchRequests.map((request) => `research:${request.id}:${request.status}`),
  ]),
  reason:
    outcomes.length === 0 && intentResearchRequests.length === 0
      ? "Active Intent has no Outcome or Research yet"
      : "Active Intent has no Outcome in progress, open Research or pending Evaluation",
});

/** Intent を Strategist へ戻すか。進行中の Outcome・未終了の Intent の Research・判断待ちの Evaluation のいずれも無いとき。 */
const intentNeedsStrategist = (outcomes: readonly OutcomeProgress[], intentResearchRequests: readonly OrchestrationResearchRequest[]) =>
  !outcomes.some((outcome) => pendingEvaluationOf(outcome) !== null) &&
  !intentResearchRequests.some((request) => openResearchStatuses.has(request.status)) &&
  !outcomes.some(isLive);

/**
 * Workspace 単位の現在状態から導いた「この Role をこの対象で起動する」という1件。Workspace Role（strategist / researcher / evaluator）は
 * Workspace を対象にし `projectId` は null、manager は Target の Project を対象にする。`key` は Workspace ID で始まり、Workspace・Project・
 * 対象・状態から決定的に決まる（manager は `<workspaceId>:<projectId>:manager:outcome:<outcomeId>`）。同じ状態からは同じ key になり、
 * 起動の重複抑止（並行・再起動・再試行）はこの key で行う。
 */
export type WorkspaceDispatch = {
  key: string;
  workspaceId: string;
  projectId: string | null;
  role: DispatchRole;
  subject: DispatchSubject;
  /** 起動理由の要約。Operational Log と起動する Role への手掛かりに使い、判断内容は含めない。 */
  reason: string;
};

/** Target の Project に Outcome の Story、または Task が無い（その Project で未分解）。 */
const isUndecomposed = (target: WorkspaceOrchestrationOutcome["targets"][number]) => target.work === null || target.work.taskCount === 0;

/**
 * 全 Target の現在の還流 cursor が最新 Evaluation の snapshot と一致しないか（未評価の還流がある、または Target の構成が変わった）。
 * Evaluation が無ければ未評価。
 */
const hasUnevaluatedExecution = (outcome: WorkspaceOrchestrationOutcome) => {
  const evaluation = outcome.latestEvaluation;
  if (!evaluation) return true;
  const evaluated = new Map(evaluation.targets.map((target) => [target.projectId, target.executionCursor]));
  return (
    evaluated.size !== outcome.targets.length ||
    outcome.targets.some((target) => target.execution === null || evaluated.get(target.projectId) !== target.execution.executionCursor)
  );
};

/**
 * Workspace の現在状態から、明示的な状態判定だけで起動すべき Role を返す（handoff v2「20」）。どの Project が担当するか・
 * 何を調査するか・Story をどう切るかは判断せず、起動された Role に委ねる。
 *
 * - 未終了の Research Request → researcher（Workspace）
 * - 判断待ちの最新 Evaluation → strategist（Workspace・Evaluation）
 * - 進行中の Outcome（active・最新 Evaluation が未判断または無い）について:
 *   - Target なし（`no_targets`）→ strategist（Workspace・Outcome）。Target Project の選択は Strategist が行う
 *   - archived の Target に未還流・`incomplete` が残る（`replan_required`）→ strategist（Workspace・Outcome）へ再計画。
 *     他の active な Target があっても起動する。Target 解除・再割当・Outcome の見直しは Strategist が判断する
 *   - active な Target のうち、その Project に Story / Task が無いもの → その Project の manager。archived の Project は起動しない
 *   - 全 Target から還流し `incomplete` が無く（`evaluable`。archive 前に還流を終えた Target を含む）、未評価の還流がある → evaluator
 * - 上記のいずれも無い Active Intent（進行中の Outcome・未終了の Research・判断待ちの Evaluation が無い）→ strategist（Workspace・Intent）。
 *   Research の要否は起動された Strategist が判断する
 *
 * archived の Workspace では何も起動しない。
 */
export const planWorkspaceDispatches = (state: WorkspaceOrchestrationState): WorkspaceDispatch[] => {
  if (state.workspace.status !== "active") return [];
  const workspaceId = state.workspace.id;
  const dispatches: WorkspaceDispatch[] = [];
  /** Workspace Role の起動。key は `<workspaceId>:<role>:<subject kind>:<subject id>` に状態の版（`suffix`）を付ける。 */
  const workspaceDispatch = (role: DispatchRole, subject: DispatchSubject, suffix: string, reason: string) =>
    dispatches.push({
      key: `${workspaceId}:${role}:${subject.kind}:${subject.id}${suffix}`,
      workspaceId,
      projectId: null,
      role,
      subject,
      reason,
    });

  for (const request of state.openResearchRequests) {
    workspaceDispatch("researcher", { kind: "research_request", id: request.id }, "", `Research Request is ${request.status}`);
  }

  const intent = state.activeIntent;
  if (!intent) return dispatches;

  for (const outcome of state.outcomes) {
    const pending = pendingEvaluationOf(outcome);
    if (pending) {
      workspaceDispatch(
        "strategist",
        { kind: "evaluation", id: pending.id },
        "",
        `Outcome ${outcome.id} has an Evaluation awaiting a Direction Decision`,
      );
    }
    if (!isLive(outcome)) continue;
    const subject: DispatchSubject = { kind: "outcome", id: outcome.id };

    if (outcome.evaluability.status === "no_targets") {
      workspaceDispatch("strategist", subject, ":no_targets", "Outcome has no Target Project");
      continue;
    }
    if (outcome.evaluability.status === "replan_required") {
      // Target の構成と未完了の Target から版を作る。再計画で状態が変われば新しい key、何も変えなければ再起動しない。
      const version = fingerprint([
        ...outcome.targets.map((target) => `target:${target.projectId}`),
        ...outcome.evaluability.unfinishedTargets.map((target) => `unfinished:${target.projectId}:${target.projectStatus}:${target.reason}`),
      ]);
      const archived = outcome.evaluability.unfinishedTargets.filter((target) => target.projectStatus === "archived");
      workspaceDispatch(
        "strategist",
        subject,
        `:replan:${version}`,
        `Archived Target Project ${archived.map((target) => target.projectId).join(", ")} has unfinished Execution`,
      );
    }
    for (const target of outcome.targets) {
      if (target.projectStatus !== "active" || !isUndecomposed(target)) continue;
      dispatches.push({
        key: `${workspaceId}:${target.projectId}:manager:outcome:${outcome.id}`,
        workspaceId,
        projectId: target.projectId,
        role: "manager",
        subject,
        reason: target.work === null ? "Target Project has no Story for the Outcome" : "Target Project's Stories have no Task",
      });
    }
    if (outcome.evaluability.status === "evaluable" && hasUnevaluatedExecution(outcome)) {
      const cursors = outcome.targets.map((target) => `${target.projectId}=${target.execution?.executionCursor ?? ""}`);
      workspaceDispatch(
        "evaluator",
        subject,
        `:${fingerprint(cursors)}`,
        `All ${outcome.targets.length} Target Projects reflected Execution that is not evaluated`,
      );
    }
  }

  if (intentNeedsStrategist(state.outcomes, state.intentResearchRequests)) {
    const { version, reason } = intentStrategistOf(state.outcomes, state.intentResearchRequests);
    workspaceDispatch("strategist", { kind: "intent", id: intent.id }, `:${version}`, reason);
  }
  return dispatches;
};
