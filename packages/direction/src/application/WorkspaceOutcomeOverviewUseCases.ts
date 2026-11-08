import { NotFoundError, ValidationError } from "@compass/shared";
import type { Intent } from "../domain/Intent.ts";
import type { IntentRepository } from "../domain/IntentRepository.ts";
import type { Outcome, OutcomeStatus } from "../domain/Outcome.ts";
import { addTaskCounts, emptyTaskCounts, summarizeTaskProgress, type TaskProgress } from "../domain/OutcomeProgress.ts";
import type { EvaluationResult } from "../domain/OutcomeEvaluation.ts";
import type { OutcomeEvaluationRepository } from "../domain/OutcomeEvaluationRepository.ts";
import type { OutcomeRepository } from "../domain/OutcomeRepository.ts";
import type { OutcomeTargetProjectRepository, OutcomeTargetProjectView } from "../domain/OutcomeTargetProject.ts";
import type { DirectionWorkspaceReader } from "./port/DirectionWorkspaceReader.ts";
import type { OutcomeProjectWorkSummary, OutcomeWorkSummaryPort } from "./port/ExecutionSummaryPort.ts";
import type { OutcomeProblemFact, OutcomeProblemPort } from "./port/OutcomeProblemPort.ts";

/** Target Project 1件のTask進捗。Storyが無ければ`progress.kind`は`not_planned`（未起票）。 */
export type OutcomeTargetProgress = {
  projectId: string;
  projectStatus: "active" | "archived";
  progress: TaskProgress;
};

/**
 * Outcomeの問題。`unknown`は問題情報を取得できなかったことで、問題なし（`none`）とは別。
 * 代表は待ち時間の長い（更新の古い）Human待ちを優先し、残りは`otherCount`で示す。全件は`items`で辿れる。
 */
export type OutcomeProblemSummary =
  | { state: "unknown" }
  | { state: "none" }
  | {
      state: "present";
      representative: OutcomeProblemFact;
      otherCount: number;
      waitingHumanCount: number;
      waitingAgentCount: number;
      items: OutcomeProblemFact[];
    };

/**
 * 提供状況（公開）。Compassには公開・リリースの記録がなく、Task受入や還流を公開として扱わないため、現在は常に`unknown`（未確認）。
 * 公開の記録を持つ入口ができたときに値を増やす。
 */
export type OutcomeDeliveryStatus = { state: "unknown" };

/**
 * 効果の確認状況。最新のOutcome Evaluationの結果だけから決める。Task進捗・還流からは推測しない。
 * `not_evaluated`は評価がまだ無いこと、`unknown`は評価を取得できなかったこと。
 */
export type OutcomeEffectStatus =
  | { state: "not_evaluated" }
  | { state: "evaluated"; result: EvaluationResult; evaluatedAt: number }
  | { state: "unknown" };

export type OutcomeAggregateProgress = TaskProgress & {
  targetProjectCount: number;
  /** Target Projectのうち、相関付いたStoryがまだ無いもの。 */
  unplannedProjectCount: number;
};

export type WorkspaceOutcomeOverview = {
  outcomeId: string;
  intentId: string;
  intentTitle: string;
  intentStatus: Intent["status"];
  title: string;
  description: string;
  hypothesis: string | null;
  status: OutcomeStatus;
  createdAt: number;
  updatedAt: number;
  targets: OutcomeTargetProgress[];
  progress: OutcomeAggregateProgress;
  problems: OutcomeProblemSummary;
  delivery: OutcomeDeliveryStatus;
  effect: OutcomeEffectStatus;
};

const compareProblems = (left: OutcomeProblemFact, right: OutcomeProblemFact) =>
  (left.kind === right.kind ? 0 : left.kind === "waiting_human" ? -1 : 1) ||
  left.updatedAt - right.updatedAt ||
  (left.consultationId < right.consultationId ? -1 : 1);

const summarizeProblems = (facts: OutcomeProblemFact[] | null): OutcomeProblemSummary => {
  if (facts === null) return { state: "unknown" };
  // 同じ相談は複数のProject・Taskに関わっても1件。同一性は相談IDだけで決める。
  const unique = [...new Map(facts.map((fact) => [fact.consultationId, fact])).values()].sort(compareProblems);
  const [representative] = unique;
  if (!representative) return { state: "none" };
  return {
    state: "present",
    representative,
    otherCount: unique.length - 1,
    waitingHumanCount: unique.filter(({ kind }) => kind === "waiting_human").length,
    waitingAgentCount: unique.filter(({ kind }) => kind === "waiting_agent").length,
    items: unique,
  };
};

/** 一覧と詳細が同じ集計で組み立てるための読取。Task進捗は検索・絞り込みと無関係に、Outcomeの全Target Projectから数える。 */
class OutcomeOverviewBuilder {
  constructor(
    private readonly workSummary: OutcomeWorkSummaryPort,
    private readonly problemPort: OutcomeProblemPort,
    private readonly evaluationRepository: Pick<OutcomeEvaluationRepository, "findByOutcome">,
  ) {}

  private async effectOf(workspaceId: string, outcomeId: string): Promise<OutcomeEffectStatus> {
    try {
      const [latest] = await this.evaluationRepository.findByOutcome(workspaceId, outcomeId);
      return latest ? { state: "evaluated", result: latest.result, evaluatedAt: latest.createdAt } : { state: "not_evaluated" };
    } catch {
      return { state: "unknown" };
    }
  }

  async build(
    workspaceId: string,
    outcomes: Outcome[],
    intents: ReadonlyMap<string, Intent>,
    allTargets: OutcomeTargetProjectView[],
  ): Promise<WorkspaceOutcomeOverview[]> {
    if (outcomes.length === 0) return [];
    const outcomeIds = new Set(outcomes.map(({ id }) => id));
    const targets = allTargets.filter(({ outcomeId }) => outcomeIds.has(outcomeId));
    const refs = targets.map(({ outcomeId, projectId }) => ({ outcomeId, projectId }));
    const works = new Map<string, OutcomeProjectWorkSummary>(
      (await this.workSummary.summarizeOutcomeProjects(refs)).map((work) => [JSON.stringify([work.outcomeId, work.projectId]), work]),
    );
    let problemsByOutcome: Map<string, OutcomeProblemFact[]> | null = null;
    try {
      const facts = await this.problemPort.listOutcomeProblems(workspaceId, [...outcomeIds], refs);
      problemsByOutcome = new Map(facts.map(({ outcomeId, problems }) => [outcomeId, problems]));
    } catch {
      problemsByOutcome = null;
    }
    const effects = new Map(await Promise.all(outcomes.map(async ({ id }) => [id, await this.effectOf(workspaceId, id)] as const)));
    return outcomes.map((outcome) => {
      const intent = intents.get(outcome.intentId);
      const outcomeTargets = targets.filter(({ outcomeId }) => outcomeId === outcome.id);
      const targetProgress: OutcomeTargetProgress[] = outcomeTargets.map((target) => {
        const work = works.get(JSON.stringify([target.outcomeId, target.projectId]));
        return {
          projectId: target.projectId,
          projectStatus: target.projectStatus,
          progress: summarizeTaskProgress(true, work !== undefined && work.storyCount > 0, work?.taskCounts ?? emptyTaskCounts()),
        };
      });
      const counts = targetProgress.reduce((sum, { progress }) => addTaskCounts(sum, progress.counts), emptyTaskCounts());
      const unplannedProjectCount = targetProgress.filter(({ progress }) => progress.kind === "not_planned").length;
      const planned = targetProgress.some(({ progress }) => progress.kind !== "not_planned");
      return {
        outcomeId: outcome.id,
        intentId: outcome.intentId,
        intentTitle: intent?.title ?? "",
        intentStatus: intent?.status ?? "active",
        title: outcome.title,
        description: outcome.description,
        hypothesis: outcome.hypothesis,
        status: outcome.status,
        createdAt: outcome.createdAt,
        updatedAt: outcome.updatedAt,
        targets: targetProgress,
        progress: {
          ...summarizeTaskProgress(targetProgress.length > 0, planned, counts),
          targetProjectCount: targetProgress.length,
          unplannedProjectCount,
        },
        problems: summarizeProblems(problemsByOutcome === null ? null : (problemsByOutcome.get(outcome.id) ?? [])),
        delivery: { state: "unknown" },
        effect: effects.get(outcome.id) ?? { state: "unknown" },
      };
    });
  }
}

export const workspaceOutcomeProblemFilters = ["present", "none", "unknown"] as const;
export type WorkspaceOutcomeProblemFilter = (typeof workspaceOutcomeProblemFilters)[number];

export type ListWorkspaceOutcomesQuery = {
  /** Outcome名・説明・貢献仮説・目標名の部分一致（大文字小文字を区別しない）。Task進捗の集計は変えない。 */
  q?: string | undefined;
  intentId?: string | undefined;
  /** `present`は問題あり、`none`は問題なしと確認できたもの、`unknown`は問題を取得できなかったもの。 */
  problem?: WorkspaceOutcomeProblemFilter | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
};

export type WorkspaceOutcomePage = {
  items: WorkspaceOutcomeOverview[];
  /** 条件に一致した件数。 */
  total: number;
  /** 条件なしのWorkspace内のOutcome件数。 */
  workspaceTotal: number;
  limit: number;
  offset: number;
};

export const defaultOutcomePageSize = 20;
export const maximumOutcomePageSize = 100;

const integerInRange = (name: string, value: number | undefined, fallback: number, min: number, max: number) => {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < min || value > max) throw new ValidationError(`${name} must be an integer from ${min} to ${max}`);
  return value;
};

/** Intentをまたぐ、Workspace内のOutcome一覧。検索・目標・問題有無で絞り、新しい順にページングする。 */
export class ListWorkspaceOutcomesUseCase {
  private readonly builder: OutcomeOverviewBuilder;

  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: Pick<IntentRepository, "findByWorkspace">,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByWorkspace">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByWorkspace">,
    workSummary: OutcomeWorkSummaryPort,
    problemPort: OutcomeProblemPort,
    evaluationRepository: Pick<OutcomeEvaluationRepository, "findByOutcome">,
  ) {
    this.builder = new OutcomeOverviewBuilder(workSummary, problemPort, evaluationRepository);
  }

  async execute(workspaceId: string, query: ListWorkspaceOutcomesQuery = {}): Promise<WorkspaceOutcomePage> {
    if (!(await this.workspaceReader.findById(workspaceId))) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const limit = integerInRange("limit", query.limit, defaultOutcomePageSize, 1, maximumOutcomePageSize);
    const offset = integerInRange("offset", query.offset, 0, 0, 1_000_000);
    if (query.problem !== undefined && !workspaceOutcomeProblemFilters.includes(query.problem)) {
      throw new ValidationError(`problem must be one of ${workspaceOutcomeProblemFilters.join(", ")}`);
    }
    const intents = new Map((await this.intentRepository.findByWorkspace(workspaceId)).map((intent) => [intent.id, intent]));
    const all = await this.outcomeRepository.findByWorkspace(workspaceId);
    const needle = query.q?.trim().toLowerCase() ?? "";
    const candidates = all.filter((outcome) => {
      if (query.intentId && outcome.intentId !== query.intentId) return false;
      if (!needle) return true;
      return [outcome.title, outcome.description, outcome.hypothesis ?? "", intents.get(outcome.intentId)?.title ?? ""]
        .some((text) => text.toLowerCase().includes(needle));
    });
    const overviews = await this.builder.build(workspaceId, candidates, intents, await this.targetRepository.listByWorkspace(workspaceId));
    const matched = query.problem === undefined
      ? overviews
      : overviews.filter(({ problems }) => (query.problem === "present" ? problems.state === "present" : problems.state === query.problem));
    return { items: matched.slice(offset, offset + limit), total: matched.length, workspaceTotal: all.length, limit, offset };
  }
}

/** Outcome 1件の詳細集計。一覧と同じ組み立てで、Target別のTask進捗・集約・問題の全件を返す。 */
export class GetWorkspaceOutcomeOverviewUseCase {
  private readonly builder: OutcomeOverviewBuilder;

  constructor(
    private readonly workspaceReader: DirectionWorkspaceReader,
    private readonly intentRepository: Pick<IntentRepository, "findById">,
    private readonly outcomeRepository: Pick<OutcomeRepository, "findByIdInWorkspace">,
    private readonly targetRepository: Pick<OutcomeTargetProjectRepository, "listByOutcome">,
    workSummary: OutcomeWorkSummaryPort,
    problemPort: OutcomeProblemPort,
    evaluationRepository: Pick<OutcomeEvaluationRepository, "findByOutcome">,
  ) {
    this.builder = new OutcomeOverviewBuilder(workSummary, problemPort, evaluationRepository);
  }

  async execute(workspaceId: string, outcomeId: string): Promise<WorkspaceOutcomeOverview> {
    if (!(await this.workspaceReader.findById(workspaceId))) throw new NotFoundError(`Workspace ${workspaceId} was not found`);
    const outcome = await this.outcomeRepository.findByIdInWorkspace(workspaceId, outcomeId);
    const targets = await this.targetRepository.listByOutcome(workspaceId, outcomeId);
    if (!outcome || !targets) throw new NotFoundError(`Outcome ${outcomeId} was not found in Workspace ${workspaceId}`);
    const intent = await this.intentRepository.findById(workspaceId, outcome.intentId);
    const intents = new Map(intent ? [[intent.id, intent] as const] : []);
    const [overview] = await this.builder.build(workspaceId, [outcome], intents, targets);
    return overview as WorkspaceOutcomeOverview;
  }
}
