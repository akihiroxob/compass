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

/** 担当待ちの主体。Workspace scopeのStrategist・Evaluator、Project scopeのManager・Worker・Reviewer、還流のRuntime、Humanの操作。 */
export type AttentionActor = "human" | "strategist" | "manager" | "worker" | "reviewer" | "evaluator" | "runtime";

export type AttentionKind =
  | "intent"
  | "outcome"
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

/** 要対応の根拠。Outcome（とTarget Project）と、Taskの件数（Task区分だけ）。 */
export type AttentionRef = { outcome: OverviewOutcome; projectId: string | null; count: number | null };

export type AttentionItem = { kind: AttentionKind; actor: AttentionActor; note: string; refs: AttentionRef[] };

export type WorkspaceAttention = { items: AttentionItem[]; outcomeFailures: number };

const taskAttention: { kind: Extract<AttentionKind, "todo" | "rejected" | "in_review" | "wait_accept">; actor: AttentionActor; note: string }[] = [
  { kind: "todo", actor: "worker", note: "ProjectのWorkerの着手待ち" },
  { kind: "rejected", actor: "worker", note: "ProjectのWorkerの再着手待ち" },
  { kind: "in_review", actor: "reviewer", note: "ProjectのReviewerの担当待ち" },
  { kind: "wait_accept", actor: "manager", note: "ProjectのManagerの受入待ち。Project Editor以上はHumanとしても受入できます" },
];

/**
 * 概要の「要対応」。Active Intentが無い・Active Outcomeが無いときはHumanのDirection登録を、各Outcomeは還流・評価の状態と
 * Target別Workから次に動く主体を上流から順に出す。Orchestratorの起動規則（`orchestrator/src/plan.ts`）と揃え、最新Evaluationが
 * 判断済みのOutcomeにはStrategist・Manager・Evaluatorの担当待ちを出さない。Taskの件数はTaskの状態だけで、Agentの稼働や
 * Claimの有効性を示さない。archivedのWorkspaceでは呼ばない。
 */
export const planWorkspaceAttention = (input: { activeIntent: boolean; outcomes: readonly OutcomePosition[] }): WorkspaceAttention => {
  if (!input.activeIntent) return { items: [{ kind: "intent", actor: "human", note: "ActiveなIntentがありません。Humanが実現したい状態を登録します", refs: [] }], outcomeFailures: 0 };
  if (input.outcomes.length === 0) return { items: [{ kind: "outcome", actor: "human", note: "Active Intentに、ActiveなOutcomeがありません", refs: [] }], outcomeFailures: 0 };
  const loaded = input.outcomes.filter((item): item is OutcomePosition & { targets: TargetWork[]; execution: OutcomeExecution } => item.targets !== null && item.execution !== null);
  const refs = new Map<AttentionKind, AttentionRef[]>();
  const add = (kind: AttentionKind, ref: AttentionRef) => refs.set(kind, [...(refs.get(kind) ?? []), ref]);
  for (const { outcome, targets, execution } of loaded) {
    const { evaluability } = execution;
    const decided = execution.latestEvaluation?.decided === true;
    if (execution.latestEvaluation && !decided) add("decision", { outcome, projectId: null, count: null });
    if (!decided && evaluability.status === "no_targets") add("no_targets", { outcome, projectId: null, count: null });
    if (!decided && evaluability.status === "replan_required") {
      for (const target of evaluability.unfinishedTargets.filter((item) => item.projectStatus === "archived")) add("replan", { outcome, projectId: target.projectId, count: null });
    }
    if (needsEvaluation(execution)) add("evaluation", { outcome, projectId: null, count: null });
    const notReflected = new Set(evaluability.unfinishedTargets.filter((item) => item.reason === "not_reflected").map((item) => item.projectId));
    for (const target of targets.filter((item) => item.projectStatus === "active")) {
      // Storyが無い・StoryにTaskが無いTargetは、そのProjectのManagerの起票・分解待ち（ExecutionSummaryではincomplete）。
      if (target.work === null || Object.values(target.work.taskCounts).every((count) => count === 0)) {
        if (!decided) add(target.work === null ? "story" : "decompose", { outcome, projectId: target.projectId, count: null });
        continue;
      }
      for (const { kind } of taskAttention) {
        const count = target.work.taskCounts[kind];
        if (count > 0) add(kind, { outcome, projectId: target.projectId, count });
      }
      // Workが終わった（未完了でない）のに還流されていないTargetは、Runtimeの還流待ち。
      if (target.work.state !== "incomplete" && notReflected.has(target.projectId)) add("reflection", { outcome, projectId: target.projectId, count: null });
    }
  }
  const order: { kind: AttentionKind; actor: AttentionActor; note: string }[] = [
    { kind: "no_targets", actor: "strategist", note: "担当するTarget Projectが無く、Strategistの判断待ち" },
    { kind: "replan", actor: "strategist", note: "archivedのTarget Projectに未完了が残り、Strategistの再計画待ち" },
    { kind: "decision", actor: "strategist", note: "最新のEvaluationを根拠にした判断が無く、Strategistの判断待ち" },
    { kind: "story", actor: "manager", note: "Target ProjectにStoryが無く、ProjectのManagerの起票待ち" },
    { kind: "decompose", actor: "manager", note: "StoryにTaskが無く、ProjectのManagerのTask分解待ち" },
    ...taskAttention,
    { kind: "reflection", actor: "runtime", note: "Workは終わったが、Runtimeの結果還流待ち" },
    { kind: "evaluation", actor: "evaluator", note: "全Target Projectから還流済みで、評価していない還流があり、Evaluatorの評価待ち" },
  ];
  const items = order.flatMap(({ kind, actor, note }) => (refs.has(kind) ? [{ kind, actor, note, refs: refs.get(kind)! }] : []));
  return { items, outcomeFailures: input.outcomes.length - loaded.length };
};

/** 要対応の見出し下の要約。取得できないOutcomeが残るときは「要対応はありません」と言わない。 */
export const attentionSummary = ({ items, outcomeFailures }: WorkspaceAttention): string | null =>
  items.length ? null : outcomeFailures ? "確認できたOutcomeに要対応はありません" : "要対応はありません";

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
