// Workspaceの概要（S10-01）の判定。現在地（Intent → Outcome → Target Project → Work → 評価可能性）と要対応を、
// 取得済みの応答から導く純関数。導線の表示だけを決め、拒否は常にserverが行う。テストからも読み込むため、他moduleをimportしない。

/** Web API `GET /api/workspaces/:workspaceId/intents/:intentId/outcome-target-work`のTarget 1件。`work`はStoryが無ければnull。 */
export type TargetWork = {
  outcomeId: string;
  projectId: string;
  projectStatus: "active" | "archived";
  createdAt: number;
  work: {
    state: "accepted" | "rejected" | "canceled" | "incomplete";
    storyCount: number;
    taskCounts: Record<"todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled", number>;
  } | null;
};
export type OutcomeTargetWork = { outcomeId: string; outcomeStatus: string; targets: TargetWork[] };

/** Web API `GET /api/workspaces/:workspaceId/outcomes/:outcomeId/target-executions`の`evaluability`。 */
export type Evaluability = {
  status: "evaluable" | "no_targets" | "replan_required" | "awaiting_execution";
  unfinishedTargets: { projectId: string; projectStatus: "active" | "archived"; reason: "not_reflected" | "incomplete" }[];
};

/** Target 1件の還流cursor。未還流はnull。現在の値はtarget-executions、評価時の値はEvaluationのsnapshotから読む。 */
export type TargetCursor = { projectId: string; executionCursor: number | null };

/**
 * Outcomeの還流と評価の状態。`latestEvaluation`は最新のEvaluation（無ければnull）で、`decided`はそれを根拠にした
 * Direction Decisionがあるか、`targetCursors`は評価snapshotにあったTarget別の還流cursor。
 */
export type OutcomeExecution = {
  evaluability: Evaluability;
  targetCursors: TargetCursor[];
  latestEvaluation: { id: string; decided: boolean; targetCursors: TargetCursor[] } | null;
};

/** target-executionsの応答のうち、還流と評価の状態の判定に使う部分。 */
export type TargetExecutionsCursor = { targets: readonly { projectId: string; execution: { summary: { executionCursor: number } } | null }[]; evaluability: Evaluability };
/** Evaluationの応答のうち、判定に使う部分（新しい順）。 */
export type EvaluationCursor = { id: string; snapshot: { targets: readonly { projectId: string; execution: { executionCursor: number } }[] } };

/**
 * target-executions・evaluations・Active IntentのDirection Decision（根拠のEvaluation ID。取得失敗はnull）から、Outcomeの還流と評価の状態を組み立てる。
 * Evaluationがあるのに判断済みかを確認できなければnull（判断待ちと断定しない）。
 */
export const buildOutcomeExecution = (
  executions: TargetExecutionsCursor,
  evaluations: readonly EvaluationCursor[],
  decidedEvaluations: ReadonlySet<string> | null,
): OutcomeExecution | null => {
  const latest = evaluations[0] ?? null;
  if (latest && !decidedEvaluations) return null;
  return {
    evaluability: executions.evaluability,
    targetCursors: executions.targets.map(({ projectId, execution }) => ({ projectId, executionCursor: execution?.summary.executionCursor ?? null })),
    latestEvaluation: latest && {
      id: latest.id,
      decided: decidedEvaluations!.has(latest.id),
      targetCursors: latest.snapshot.targets.map(({ projectId, execution }) => ({ projectId, executionCursor: execution.executionCursor })),
    },
  };
};

export type OverviewOutcome = { id: string; intentId: string; title: string };

/**
 * Active Outcome 1件の現在地。`targets`はTarget別Work（一覧の取得に失敗したらnull）、`execution`は評価可能性・還流・評価の状態
 * （どれかの取得に失敗したらnull）。どちらかがnullのOutcomeは要対応を判定せず、「確認できません」として数える（空・Targetなしと混同しない）。
 */
export type OutcomePosition = { outcome: OverviewOutcome; targets: TargetWork[] | null; execution: OutcomeExecution | null };

/**
 * 現在の還流が最新Evaluationで評価済みでないか（Evaluationが無い、Targetの構成が変わった、新しい還流がある）。
 * Orchestratorの`hasUnevaluatedExecution`（`orchestrator/src/plan.ts`）と同じ規則。
 */
const hasUnevaluatedExecution = ({ targetCursors, latestEvaluation }: OutcomeExecution) => {
  if (!latestEvaluation) return true;
  const evaluated = new Map(latestEvaluation.targetCursors.map((target) => [target.projectId, target.executionCursor]));
  return evaluated.size !== targetCursors.length || targetCursors.some((target) => target.executionCursor === null || evaluated.get(target.projectId) !== target.executionCursor);
};

/**
 * Outcomeの評価の段階。最新Evaluationが判断済み（`decided`）ならStrategistの判断で次へ進んだもの、未判断なら判断待ち
 * （`decision_pending`）。Evaluationが無く全Targetが還流済みなら評価待ち。それ以外は評価可能性の状態のまま。
 * 判断待ちの間に新しい還流があれば、要対応では評価待ちも出す（`needsEvaluation`）。
 */
export type EvaluationStage = "decided" | "decision_pending" | "evaluation_pending" | Exclude<Evaluability["status"], "evaluable">;

export const evaluationStage = ({ latestEvaluation, evaluability }: OutcomeExecution): EvaluationStage => {
  if (latestEvaluation) return latestEvaluation.decided ? "decided" : "decision_pending";
  return evaluability.status === "evaluable" ? "evaluation_pending" : evaluability.status;
};

/** 未評価の還流があり、Evaluatorの評価（再評価を含む）を待つか。判断済みのOutcomeは対象外（Orchestratorと同じ）。 */
const needsEvaluation = (execution: OutcomeExecution) =>
  !execution.latestEvaluation?.decided && execution.evaluability.status === "evaluable" && hasUnevaluatedExecution(execution);

/** 担当待ちの主体。Workspace scopeのStrategist・Researcher・Evaluator、Project scopeのManager・Worker・Reviewer、還流のRuntime、Humanの操作。 */
export type AttentionActor = "human" | "strategist" | "researcher" | "manager" | "worker" | "reviewer" | "evaluator" | "runtime";

export type AttentionKind =
  | "intent"
  | "next_direction"
  | "outcome"
  | "research"
  | "no_targets"
  | "replan"
  | "decision"
  | "story"
  | "decompose"
  | "todo"
  | "rejected"
  | "in_review"
  | "wait_accept"
  | "reflection"
  | "evaluation";

export type OverviewIntent = { id: string; title: string };

/** Workspaceの未終了（`requested`・`running`）のResearch Request。`originIntentId`は依頼元のIntent。 */
export type OverviewResearch = { id: string; question: string; status: string; originIntentId: string | null };

const openResearchStatuses = new Set(["requested", "running"]);

/** Research Requestの一覧から未終了のものだけを残す。Orchestratorの`openResearchStatuses`と同じ状態。 */
export const openResearchOf = (requests: readonly OverviewResearch[]): OverviewResearch[] => requests.filter((request) => openResearchStatuses.has(request.status));

/** 要対応の根拠。Outcome（とTarget Project、Taskの件数）、Active Intent、またはResearch Request。 */
export type AttentionRef =
  | { on: "outcome"; outcome: OverviewOutcome; projectId: string | null; count: number | null }
  | { on: "intent"; intent: OverviewIntent }
  | { on: "research"; request: OverviewResearch };

export type AttentionItem = { kind: AttentionKind; actor: AttentionActor; note: string; refs: AttentionRef[] };

/**
 * `outcomeFailures`は還流・評価の状態を取得できないActive Outcomeの件数。`unconfirmed`は取得失敗で判定できない要対応の説明で、
 * どちらかが残るときは要対応が無いと断定しない。
 */
export type WorkspaceAttention = { items: AttentionItem[]; outcomeFailures: number; unconfirmed: string[] };

const taskAttention: { kind: Extract<AttentionKind, "todo" | "rejected" | "in_review" | "wait_accept">; actor: AttentionActor; note: string }[] = [
  { kind: "todo", actor: "worker", note: "ProjectのWorkerの着手待ち" },
  { kind: "rejected", actor: "worker", note: "ProjectのWorkerの再着手待ち" },
  { kind: "in_review", actor: "reviewer", note: "ProjectのReviewerの担当待ち" },
  { kind: "wait_accept", actor: "manager", note: "ProjectのManagerの受入待ち。Project Editor以上はHumanとしても受入できます" },
];

const attentionOrder: { kind: AttentionKind; actor: AttentionActor; note: string }[] = [
  { kind: "intent", actor: "human", note: "ActiveなIntentがありません。Humanが実現したい状態を登録します" },
  { kind: "next_direction", actor: "strategist", note: "進行中のOutcome・未終了のResearch・判断待ちのEvaluationが無く、Active Intentに対するStrategistの次の判断待ち（Outcomeの登録・Researchの依頼等）" },
  { kind: "outcome", actor: "human", note: "Active Intentに、ActiveなOutcomeがありません。Humanが判断した場合は登録できます" },
  { kind: "research", actor: "researcher", note: "未終了のResearch Requestがあり、Researcherの調査待ち" },
  { kind: "no_targets", actor: "strategist", note: "担当するTarget Projectが無く、Strategistの判断待ち" },
  { kind: "replan", actor: "strategist", note: "archivedのTarget Projectに未完了が残り、Strategistの再計画待ち" },
  { kind: "decision", actor: "strategist", note: "最新のEvaluationを根拠にした判断が無く、Strategistの判断待ち" },
  { kind: "story", actor: "manager", note: "Target ProjectにStoryが無く、ProjectのManagerの起票待ち" },
  { kind: "decompose", actor: "manager", note: "StoryにTaskが無く、ProjectのManagerのTask分解待ち" },
  ...taskAttention,
  { kind: "reflection", actor: "runtime", note: "Workは終わったが、Runtimeの結果還流待ち" },
  { kind: "evaluation", actor: "evaluator", note: "全Target Projectから還流済みで、評価していない還流があり、Evaluatorの評価待ち" },
];

/**
 * 概要の「要対応」の入力。`outcomes`はActive Intent配下のActive Outcomeの現在地。`pendingPastOutcomes`は取消以外のActiveでない
 * Outcomeのうち最新Evaluationが判断待ちのもの、`research`はWorkspaceの未終了のResearch Request（どちらも取得失敗はnull）。
 */
export type AttentionInput = {
  activeIntent: OverviewIntent | null;
  outcomes: readonly OutcomePosition[];
  pendingPastOutcomes: readonly OverviewOutcome[] | null;
  research: readonly OverviewResearch[] | null;
};

/**
 * 概要の「要対応」。Orchestratorの起動規則（`orchestrator/src/plan.ts`の`planWorkspaceDispatches`）と揃え、次に動く主体を上流から
 * 順に出す。未終了のResearchはResearcher、各Active Outcomeは還流・評価の状態とTarget別Workから、取消以外の終了したOutcomeの
 * 判断待ちEvaluationはStrategistへ。進行中のOutcome（判断済みでないActive Outcome）・Intentを起点にした未終了のResearch・
 * 判断待ちのEvaluationがどれも無いActive Intentは、Strategistの次の判断待ち（`intentNeedsStrategist`）。どれかを取得できずに
 * 判定できなければ、要対応を出さず`unconfirmed`に理由を返す。最新Evaluationが判断済みのOutcomeにはStrategist・Manager・
 * Evaluatorの担当待ちを出さない。Active Intent・Active Outcomeが無ければHumanの登録も出す。Taskの件数はTaskの状態だけで、
 * Agentの稼働やClaimの有効性を示さない。archivedのWorkspaceでは呼ばない。
 */
export const planWorkspaceAttention = (input: AttentionInput): WorkspaceAttention => {
  const refs = new Map<AttentionKind, AttentionRef[]>();
  const add = (kind: AttentionKind, ref: AttentionRef | null) => refs.set(kind, [...(refs.get(kind) ?? []), ...(ref ? [ref] : [])]);
  const unconfirmed: string[] = [];
  const outcomeRef = (outcome: OverviewOutcome, projectId: string | null = null, count: number | null = null): AttentionRef => ({ on: "outcome", outcome, projectId, count });
  if (input.research === null) unconfirmed.push("Research Requestを取得できないため、Researcherの調査待ちを確認できません");
  for (const request of input.research ?? []) add("research", { on: "research", request });
  const { activeIntent } = input;
  if (!activeIntent) add("intent", null);
  const loaded = activeIntent ? input.outcomes.filter((item): item is OutcomePosition & { targets: TargetWork[]; execution: OutcomeExecution } => item.targets !== null && item.execution !== null) : [];
  if (activeIntent && input.outcomes.length === 0) add("outcome", null);
  for (const outcome of activeIntent ? input.pendingPastOutcomes ?? [] : []) add("decision", outcomeRef(outcome));
  for (const { outcome, targets, execution } of loaded) {
    const { evaluability } = execution;
    const decided = execution.latestEvaluation?.decided === true;
    if (execution.latestEvaluation && !decided) add("decision", outcomeRef(outcome));
    if (!decided && evaluability.status === "no_targets") add("no_targets", outcomeRef(outcome));
    if (!decided && evaluability.status === "replan_required") {
      for (const target of evaluability.unfinishedTargets.filter((item) => item.projectStatus === "archived")) add("replan", outcomeRef(outcome, target.projectId));
    }
    if (needsEvaluation(execution)) add("evaluation", outcomeRef(outcome));
    const notReflected = new Set(evaluability.unfinishedTargets.filter((item) => item.reason === "not_reflected").map((item) => item.projectId));
    for (const target of targets.filter((item) => item.projectStatus === "active")) {
      // Storyが無い・StoryにTaskが無いTargetは、そのProjectのManagerの起票・分解待ち（ExecutionSummaryではincomplete）。
      if (target.work === null || Object.values(target.work.taskCounts).every((count) => count === 0)) {
        if (!decided) add(target.work === null ? "story" : "decompose", outcomeRef(outcome, target.projectId));
        continue;
      }
      for (const { kind } of taskAttention) {
        const count = target.work.taskCounts[kind];
        if (count > 0) add(kind, outcomeRef(outcome, target.projectId, count));
      }
      // Workが終わった（未完了でない）のに還流されていないTargetは、Runtimeの還流待ち。
      if (target.work.state !== "incomplete" && notReflected.has(target.projectId)) add("reflection", outcomeRef(outcome, target.projectId));
    }
  }
  const outcomeFailures = activeIntent ? input.outcomes.length - loaded.length : 0;
  if (activeIntent) {
    // 確認できた範囲で、進行中のOutcome・判断待ちのEvaluation・Intentを起点にした未終了のResearchがあれば、Intentの判断は要らない。
    const progressing =
      loaded.some(({ execution }) => execution.latestEvaluation?.decided !== true) ||
      (input.pendingPastOutcomes?.length ?? 0) > 0 ||
      (input.research ?? []).some((request) => request.originIntentId === activeIntent.id);
    const unknown = [
      ...(outcomeFailures ? ["Active Outcomeの還流・評価の状態"] : []),
      ...(input.pendingPastOutcomes === null ? ["終了したOutcomeのEvaluation"] : []),
      ...(input.research === null ? ["Research Request"] : []),
    ];
    if (!progressing && unknown.length) unconfirmed.push(`${unknown.join("・")}を取得できないため、Active IntentにStrategistの次の判断が必要か確認できません`);
    else if (!progressing) add("next_direction", { on: "intent", intent: activeIntent });
  }
  const items = attentionOrder.flatMap(({ kind, actor, note }) => (refs.has(kind) ? [{ kind, actor, note, refs: refs.get(kind)! }] : []));
  return { items, outcomeFailures, unconfirmed };
};

/** 要対応の見出し下の要約。取得できないOutcome・判定できない要対応が残るときは「要対応はありません」と言わない。 */
export const attentionSummary = ({ items, outcomeFailures, unconfirmed }: WorkspaceAttention): string | null =>
  items.length ? null : outcomeFailures || unconfirmed.length ? "確認できた範囲に要対応はありません" : "要対応はありません";

/**
 * Outcome・Intentの詳細を開くProject。詳細画面のrouteはProject配下で、Project Membershipで認可される。
 * Target Projectのうち開けるものを優先し、無ければWorkspace内で開けるactiveなProject。どれも開けなければnull（リンクにしない）。
 */
export const pickOpenProject = (
  preferred: readonly string[],
  projects: readonly { id: string; status: "active" | "archived"; canOpen: boolean }[],
): string | null => {
  const openable = new Map(projects.filter((project) => project.canOpen).map((project) => [project.id, project]));
  return preferred.find((id) => openable.has(id)) ?? [...openable.values()].find((project) => project.status === "active")?.id ?? null;
};

/**
 * 概要のProject一覧の、ProjectがTargetになっているActive Outcomeの説明。Intent・Outcomeを取得できない（`outcomes`がnull）、
 * またはTarget別Workを取得できないOutcomeがあるときは、0件と断定せず確認できない旨を出す。
 */
export const projectTargetNote = (outcomes: readonly OutcomePosition[] | null, projectId: string): string => {
  if (outcomes === null) return "Targetか確認できません（Intent・Outcomeを取得できません）";
  const count = outcomes.filter((item) => item.targets?.some((target) => target.projectId === projectId)).length;
  const unknown = outcomes.filter((item) => item.targets === null).length;
  if (count === 0) return unknown ? `Targetか確認できません（Outcome ${unknown}件のTargetを取得できません）` : "Active OutcomeのTargetではありません";
  return `Active Outcome ${count}件のTarget${unknown ? `（ほかOutcome ${unknown}件は確認できません）` : ""}`;
};
