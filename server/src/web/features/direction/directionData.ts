// Workspaceの概要・方向とProjectの概要が共有するDirectionの取得。Workspace所有のDirectionはWorkspace Membership、所属ProjectのStory / TaskはProject Membershipで読む。
import { request, settle, type Part } from "../../api";
import { workspaceApiPath } from "../../paths";
import type { DirectionDecision } from "../decision";
import { evaluationsPath, type OutcomeEvaluation, type OutcomeExecutionRecord } from "../execution";
import { splitIntents, type Intent } from "../intent";
import { splitOutcomes, type Outcome } from "../outcome";
import type { TargetExecutionRecord } from "./direction";
import {
  buildOutcomeExecution,
  openResearchOf,
  type EvaluationCursor,
  type Evaluability,
  type OutcomeExecution,
  type OutcomePosition,
  type OutcomeTargetWork,
  type OverviewOutcome,
  type OverviewResearch,
  type TargetExecutionsCursor,
  type TargetWork,
} from "./overview";

/** Active Outcomeの現在地と、その本文（成功条件等）。 */
export type DirectionPosition = OutcomePosition & { detail: Outcome };
/**
 * `otherOutcomes`はActive Intent配下のActive以外（取消・評価済み等）のOutcome。`pendingPastOutcomes`はそのうち取消以外で、
 * 最新Evaluationを根拠にしたDirection Decisionが無いもの（確認できなければnull）。
 */
export type DirectionData = {
  activeIntent: Intent | null;
  pastIntents: Intent[];
  outcomes: DirectionPosition[];
  otherOutcomes: Outcome[];
  pendingPastOutcomes: OverviewOutcome[] | null;
};

/** Active IntentのDirection Decisionが根拠にしたEvaluation（判断済みの判定に使う）。取得できなければnull。 */
export const loadDecidedEvaluations = (workspaceId: string, intentId: string): Promise<Set<string> | null> =>
  request<{ decisions: { evaluationId: string | null }[] }>(workspaceApiPath(workspaceId, `/intents/${intentId}/decisions`)).then(
    (body) => new Set(body.decisions.flatMap(({ evaluationId }) => (evaluationId ? [evaluationId] : []))),
    () => null,
  );

/**
 * Outcomeの還流・評価の状態。評価可能性・現在の還流cursorはtarget-executions、最新Evaluationとその評価snapshotはevaluations、
 * 判断済みかはActive IntentのDirection Decision（`decidedEvaluations`、取得失敗はnull）から読む。どれかを読めなければnull。
 */
const loadExecution = async (workspaceId: string, outcomeId: string, decidedEvaluations: Set<string> | null): Promise<OutcomeExecution | null> => {
  try {
    const [executions, { evaluations }] = await Promise.all([
      request<TargetExecutionsCursor>(workspaceApiPath(workspaceId, `/outcomes/${outcomeId}/target-executions`)),
      request<{ evaluations: EvaluationCursor[] }>(evaluationsPath(workspaceId, outcomeId)),
    ]);
    return buildOutcomeExecution(executions, evaluations, decidedEvaluations);
  } catch {
    return null;
  }
};

/**
 * 取消以外のActiveでないOutcomeのうち、最新Evaluationが判断待ちのもの（Orchestratorの`pendingEvaluationOf`と同じ）。
 * 対象が無ければ取得しない。Direction Decision・Evaluationのどれかを取得できなければnull。
 */
const loadPendingPastOutcomes = async (workspaceId: string, past: readonly Outcome[], decidedEvaluations: Set<string> | null): Promise<OverviewOutcome[] | null> => {
  const candidates = past.filter((outcome) => outcome.status !== "cancelled");
  if (candidates.length === 0) return [];
  if (!decidedEvaluations) return null;
  try {
    const latest = await Promise.all(candidates.map((outcome) => request<{ evaluations: EvaluationCursor[] }>(evaluationsPath(workspaceId, outcome.id)).then(({ evaluations }) => evaluations[0] ?? null)));
    return candidates.flatMap((outcome, index) => {
      const evaluation = latest[index];
      return evaluation && !decidedEvaluations.has(evaluation.id) ? [{ id: outcome.id, intentId: outcome.intentId, title: outcome.title }] : [];
    });
  } catch {
    return null;
  }
};

/** Workspaceの未終了のResearch Request（Orchestratorが起動を判定する対象）。 */
export const loadOpenResearch = (workspaceId: string): Promise<OverviewResearch[]> =>
  request<{ requests: OverviewResearch[] }>(workspaceApiPath(workspaceId, "/research-requests")).then(({ requests }) =>
    openResearchOf(requests).map(({ id, question, status, originIntentId }) => ({ id, question, status, originIntentId })),
  );

/** Intent配下のOutcomeごとのTarget別Work。取得できなければnull。 */
export const loadTargetWork = (workspaceId: string, intentId: string): Promise<Map<string, OutcomeTargetWork["targets"]> | null> =>
  request<{ outcomes: OutcomeTargetWork[] }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcome-target-work`)).then(
    (body) => new Map(body.outcomes.map((item) => [item.outcomeId, item.targets])),
    () => null,
  );

/**
 * Active Intent配下のOutcomeと、Active OutcomeごとのTarget別Work・還流と評価の状態。Target別Work・Direction DecisionはIntent単位の1回、
 * 還流と評価はOutcomeごとに読み、失敗したものは`null`にして他のOutcomeの表示を妨げない。
 */
export const loadDirection = async (workspaceId: string): Promise<DirectionData> => {
  const { active: activeIntent, past: pastIntents } = splitIntents((await request<{ intents: Intent[] }>(workspaceApiPath(workspaceId, "/intents"))).intents);
  if (!activeIntent) return { activeIntent, pastIntents, outcomes: [], otherOutcomes: [], pendingPastOutcomes: [] };
  const [{ outcomes }, targetWork, decidedEvaluations] = await Promise.all([
    request<{ outcomes: Outcome[] }>(workspaceApiPath(workspaceId, `/intents/${activeIntent.id}/outcomes`)),
    loadTargetWork(workspaceId, activeIntent.id),
    loadDecidedEvaluations(workspaceId, activeIntent.id),
  ]);
  const { active, past } = splitOutcomes(outcomes);
  const positions = active.map(async (outcome): Promise<DirectionPosition> => ({
    outcome: { id: outcome.id, intentId: outcome.intentId, title: outcome.title },
    detail: outcome,
    targets: targetWork?.get(outcome.id) ?? null,
    execution: await loadExecution(workspaceId, outcome.id, decidedEvaluations),
  }));
  const [resolved, pendingPastOutcomes] = await Promise.all([Promise.all(positions), loadPendingPastOutcomes(workspaceId, past, decidedEvaluations)]);
  return { activeIntent, pastIntents, outcomes: resolved, otherOutcomes: past, pendingPastOutcomes };
};

/** Web API `GET /api/workspaces/:workspaceId/outcomes/:outcomeId/target-executions`の応答。Summary・EvidenceはTarget Project別のまま。 */
export type TargetExecutions = {
  targets: TargetExecutionRecord<OutcomeExecutionRecord>[];
  nonTargetExecutions: OutcomeExecutionRecord[];
  evaluability: Evaluability;
};

/**
 * WorkspaceのOutcome詳細。Outcome本文は必須で、読めなければ画面全体を失敗にする。Target別の還流・Target別Work・Evaluation・
 * Direction Decisionは部分ごとに失敗を出し、取得失敗を空（Targetなし・未評価）として表示しない。
 */
export type OutcomeDetailData = {
  outcome: Outcome;
  executions: Part<TargetExecutions>;
  targetWork: TargetWork[] | null;
  evaluations: Part<OutcomeEvaluation[]>;
  decisions: Part<DirectionDecision[]>;
};

export const loadOutcomeDetail = async (workspaceId: string, intentId: string, outcomeId: string, notFound: string): Promise<OutcomeDetailData> => {
  const [{ outcome }, executions, targetWork, evaluations, decisions] = await Promise.all([
    request<{ outcome: Outcome }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcomes/${outcomeId}`)),
    settle(request<TargetExecutions>(workspaceApiPath(workspaceId, `/outcomes/${outcomeId}/target-executions`)), notFound),
    loadTargetWork(workspaceId, intentId),
    settle(request<{ evaluations: OutcomeEvaluation[] }>(evaluationsPath(workspaceId, outcomeId)).then((body) => body.evaluations), notFound),
    settle(request<{ decisions: DirectionDecision[] }>(workspaceApiPath(workspaceId, `/intents/${intentId}/decisions`)).then((body) => body.decisions), notFound),
  ]);
  return { outcome, executions, targetWork: targetWork ? targetWork.get(outcomeId) ?? [] : null, evaluations, decisions };
};
