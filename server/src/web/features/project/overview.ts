// Project詳細の概要（S10-03）の判定。表示から分けた純関数で、導線の表示だけを決める（拒否は常にserverが行う）。
// Projectは実行境界で、貢献するOutcomeは所属WorkspaceのDirectionから読む。テストからも読み込むため、純関数のmodule以外をimportしない。
import { contributionNote } from "../workspace/direction.ts";
import { evaluationStage, type EvaluationStage, type OutcomeExecution, type OutcomePosition, type OverviewOutcome, type TargetWork } from "../workspace/overview.ts";

/** 判定に使うTaskの項目（Executionの`ExecutionTask`の一部）。 */
export type OverviewTask = {
  id: string;
  status: "todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled";
  activeClaim: { expiresAt: number } | null;
};
/** 概要で判定に使うProject scopeのAgentのRole。 */
export type OverviewRole = "manager" | "worker" | "reviewer" | "runtime";

// ---- Project詳細のview。`?view=`で表し、再読込・共有・戻るで同じviewへ戻る。 ----

export const projectViews = ["overview", "direction", "work", "records", "settings"] as const;
export type ProjectView = (typeof projectViews)[number];
export const projectViewLabels: Record<ProjectView, string> = { overview: "概要", direction: "方向", work: "実行", records: "記録", settings: "設定" };

/** 指定が無い・不正な値は「概要」。 */
export const parseProjectView = (value: string | null): ProjectView =>
  projectViews.find((view) => view === value) ?? "overview";

/** viewのURL。`hash`はview内の要素（Task・Role行など）のid。 */
export const projectViewPath = (projectId: string, view: ProjectView, hash?: string) =>
  `/projects/${projectId}?view=${view}${hash ? `#${hash}` : ""}`;

// ---- 現在地のWork。各Taskをどれか1つの区分に入れる。 ----

export type WorkBucket = "todo" | "doing" | "reclaimable" | "in_review" | "wait_accept" | "rejected";
export const workBuckets = ["todo", "doing", "reclaimable", "in_review", "wait_accept", "rejected"] as const satisfies readonly WorkBucket[];

/** `now`時点で期限内のClaimを持つか（表示中に期限を過ぎた場合も、serverの`reclaimable`と同じく保持していない扱い）。 */
export const holdsClaim = (task: Pick<OverviewTask, "activeClaim">, now: number) => task.activeClaim !== null && task.activeClaim.expiresAt > now;

/** Taskの区分。受入済み・取消は数えない。期限内Claimの無い`doing`は再取得待ち。 */
export const workBucket = (task: Pick<OverviewTask, "status" | "activeClaim">, now: number): WorkBucket | null => {
  if (task.status === "doing") return holdsClaim(task, now) ? "doing" : "reclaimable";
  if (task.status === "accepted" || task.status === "canceled") return null;
  return task.status;
};

/** 区分ごとの件数。0件の区分は省く。 */
export const countWork = (tasks: readonly OverviewTask[], now: number): { bucket: WorkBucket; count: number }[] =>
  workBuckets
    .map((bucket) => ({ bucket, count: tasks.filter((task) => workBucket(task, now) === bucket).length }))
    .filter((item) => item.count > 0);

/** `now`より後に期限を迎える最も早いClaimの期限。概要はこの時刻に区分・次の行動を再判定する。無ければ`null`。 */
export const nextClaimExpiry = (tasks: readonly Pick<OverviewTask, "activeClaim">[], now: number): number | null => {
  const expiries = tasks.flatMap((task) => (task.activeClaim && task.activeClaim.expiresAt > now ? [task.activeClaim.expiresAt] : []));
  return expiries.length ? Math.min(...expiries) : null;
};

// ---- 貢献Outcome。所属WorkspaceのActive Outcomeのうち、このProjectがTargetのもの。 ----

/**
 * このProjectの貢献 1件。`target`はこのProjectのTarget別Work、`otherTargets`はほかのTarget Projectの件数（Workは持たない）、
 * `execution`は還流・評価の状態（取得できなければnull）。
 */
export type ProjectContribution = { outcome: OverviewOutcome; target: TargetWork; otherTargets: number; execution: OutcomeExecution | null };

/**
 * Active Outcomeの現在地から、このProjectがTargetのOutcomeだけを取り出す。ほかのTarget ProjectのWorkは件数だけにして持ち出さない。
 * Target別Workを取得できないOutcomeは、Targetかどうかを断定せず`unknown`に入れる。
 */
export const projectContributions = (outcomes: readonly OutcomePosition[], projectId: string): { items: ProjectContribution[]; unknown: OverviewOutcome[] } => ({
  items: outcomes.flatMap(({ outcome, targets, execution }) => {
    const target = targets?.find((item) => item.projectId === projectId);
    return target ? [{ outcome, target, otherTargets: targets!.length - 1, execution }] : [];
  }),
  unknown: outcomes.filter((item) => item.targets === null).map((item) => item.outcome),
});

/** 評価の段階。還流・評価の状態を取得できなければnull。 */
export const contributionStage = ({ execution }: ProjectContribution): EvaluationStage | null => (execution ? evaluationStage(execution) : null);

/** このProjectの還流の状態。現在の還流cursorがあれば還流済み。還流・評価の状態を取得できなければnull。 */
const reflected = ({ execution }: ProjectContribution, projectId: string): boolean | null =>
  execution ? (execution.targetCursors.find((item) => item.projectId === projectId)?.executionCursor ?? null) !== null : null;

/** このProjectのWorkの段階の説明（Workspaceの方向の`contributionNote`と同じ文言）。還流の状態を取得できなければその旨を出す。 */
export const projectContributionNote = (contribution: ProjectContribution): string => {
  const { target, execution } = contribution;
  if (!execution) return target.work === null ? "Storyはまだありません（還流・評価の状態は確認できません）" : "還流・評価の状態を確認できません";
  const unfinished = execution.evaluability.unfinishedTargets.find((item) => item.projectId === target.projectId)?.reason ?? null;
  return contributionNote({ work: target.work, record: reflected(contribution, target.projectId) ? true : null, unfinished, projectStatus: target.projectStatus });
};

// ---- 次の行動。Project scopeのAgent（Manager・Worker・Reviewer・Runtime）とHumanの操作だけを出す。 ----
// Intent・Outcome・Target・評価・判断はWorkspace scopeのため、Workspaceの概要・方向に出す。

export type OverviewPermissions = { intervene: boolean; grantManage: boolean; credentialManage: boolean };

export type MyAction =
  | { kind: "accept"; label: string; allowed: true; taskId: string }
  | { kind: "grant"; role: OverviewRole; label: string; allowed: boolean; requestTo: string }
  | { kind: "credential"; label: string; allowed: true; principalIds: readonly string[] };

export type WaitingKind = "story" | "decompose" | "reflection" | "todo" | "rejected" | "reclaimable" | "in_review" | "wait_accept";
export type WaitingItem = {
  kind: WaitingKind;
  count: number;
  /** 次に動く担当（Role）と、その説明。 */
  role: OverviewRole;
  note: string;
  unassigned: boolean;
  /** 根拠の詳細。OutcomeはWorkspaceのOutcome詳細、Taskは「実行」viewの該当Task。 */
  outcomes: OverviewOutcome[];
  taskIds: string[];
};

/** `outcomeFailures`は還流・評価の状態、またはTargetかどうかを確認できないOutcomeの件数。 */
export type NextActions = { mine: MyAction[]; waiting: WaitingItem[]; outcomeFailures: number };

export type NextActionInput = {
  /** 貢献Outcome。所属WorkspaceのDirectionを読めなければnull（Outcomeの担当待ちを判定しない）。 */
  contributions: { items: readonly ProjectContribution[]; unknown: readonly OverviewOutcome[] } | null;
  tasks: readonly OverviewTask[];
  assignedRoles: ReadonlySet<string>;
  /** Credentialの無い割当済みAgent。Credentialを参照できない利用者は`null`（推測させない）。 */
  agentsWithoutCredential: readonly string[] | null;
  permissions: OverviewPermissions;
  now: number;
};

export const maxMyActions = 3;

const roleNames: Record<OverviewRole, string> = {
  manager: "Manager",
  worker: "Worker",
  reviewer: "Reviewer",
  runtime: "Runtime",
};

/** Executionの区分で、Agentが次に動く必要のあるTaskの担当。期限内Claimを持つTaskは含めない（「Claim保持中」に出る）。 */
const taskWaiting: { kind: Extract<WaitingKind, WorkBucket>; role: OverviewRole; note: string }[] = [
  { kind: "todo", role: "worker", note: "Workerの着手待ち" },
  { kind: "rejected", role: "worker", note: "Workerの再着手待ち" },
  { kind: "reclaimable", role: "worker", note: "Claimの期限が切れ、Workerの再取得待ち" },
  { kind: "in_review", role: "reviewer", note: "Reviewerの担当待ち" },
  { kind: "wait_accept", role: "manager", note: "Managerの担当待ち。Editor以上はHumanとしても受入できます" },
];

/**
 * 貢献Outcome 1件の担当待ち。Workspaceの要対応（`planWorkspaceAttention`）と同じ規則で、このProjectのTargetだけを見る。
 * 最新Evaluationが判断済みのOutcomeには起票・分解待ちを出さない。
 */
const contributionWaiting = (contribution: ProjectContribution): Extract<WaitingKind, "story" | "decompose" | "reflection"> | null => {
  const { target, execution } = contribution;
  if (!execution || target.projectStatus === "archived") return null;
  const decided = execution.latestEvaluation?.decided === true;
  if (target.work === null) return decided ? null : "story";
  if (Object.values(target.work.taskCounts).every((count) => count === 0)) return decided ? null : "decompose";
  const notReflected = execution.evaluability.unfinishedTargets.some((item) => item.projectId === target.projectId && item.reason === "not_reflected");
  return target.work.state !== "incomplete" && notReflected ? "reflection" : null;
};

/**
 * 概要の「次の行動」。「あなたの操作」は条件を上から評価して最大3件、権限が無いものは依頼先にする（Humanが代行できない担当待ちはボタンにしない）。
 * 「Agentの担当待ち」は貢献OutcomeをこのProjectのStory・Task分解・還流の段階で、Taskを期限内Claimの有無で判定する。archivedでは呼ばない。
 */
export const planNextActions = (input: NextActionInput): NextActions => {
  const { contributions, tasks, assignedRoles, permissions, now } = input;
  const waitingTasks = tasks.filter((task) => !holdsClaim(task, now));
  const tasksIn = (bucket: WorkBucket) => waitingTasks.filter((task) => workBucket(task, now) === bucket);
  const outcomesAt = (kind: WaitingKind) => (contributions?.items ?? []).filter((item) => contributionWaiting(item) === kind).map((item) => item.outcome);

  const outcomeWaiting = (kind: WaitingKind, role: OverviewRole, note: string): WaitingItem => {
    const outcomes = outcomesAt(kind);
    return { kind, count: outcomes.length, role, note, unassigned: !assignedRoles.has(role), outcomes, taskIds: [] };
  };
  const waiting = [
    outcomeWaiting("story", "manager", "このProjectにStoryが無く、Managerの起票待ち"),
    outcomeWaiting("decompose", "manager", "StoryにTaskが無く、ManagerのTask分解待ち"),
    ...taskWaiting.map(({ kind, role, note }): WaitingItem => {
      const matched = tasksIn(kind);
      return { kind, count: matched.length, role, note, unassigned: !assignedRoles.has(role), outcomes: [], taskIds: matched.map((task) => task.id) };
    }),
    outcomeWaiting("reflection", "runtime", "Workは終わったが、Runtimeの結果還流待ち"),
  ].filter((item) => item.count > 0);

  const grant = (role: OverviewRole, needed: boolean): MyAction[] =>
    needed && !assignedRoles.has(role) ? [{ kind: "grant", role, label: `${roleNames[role]}を割り当てる`, allowed: permissions.grantManage, requestTo: "Administrator以上へ依頼" }] : [];
  const acceptable = tasksIn("wait_accept");
  const mine: MyAction[] = [
    ...(acceptable.length && permissions.intervene ? [{ kind: "accept", label: `受入待ちのTaskを確認（${acceptable.length}件）`, allowed: true, taskId: acceptable[0]!.id } as const] : []),
    ...grant("manager", outcomesAt("story").length + outcomesAt("decompose").length > 0),
    ...grant("worker", tasksIn("todo").length + tasksIn("rejected").length + tasksIn("reclaimable").length > 0),
    ...grant("reviewer", tasks.some((task) => task.status === "in_review")),
    ...(permissions.credentialManage && input.agentsWithoutCredential?.length
      ? [{ kind: "credential", label: "Credentialを発行", allowed: true, principalIds: input.agentsWithoutCredential } as const]
      : []),
  ];
  const outcomeFailures = contributions ? contributions.items.filter((item) => item.execution === null).length + contributions.unknown.length : 0;
  return { mine: mine.slice(0, maxMyActions), waiting, outcomeFailures };
};

/** 「次の行動」の見出し下の要約。担当待ち・取得失敗が残るときは「今すぐ必要な操作はありません」と言わない。 */
export const nextActionSummary = ({ mine, waiting, outcomeFailures }: NextActions): string | null => {
  if (mine.length) return null;
  return waiting.length || outcomeFailures ? "あなたの操作はありません" : "今すぐ必要な操作はありません";
};

/**
 * Credentialの無い割当済みAgent（Runtimeは`runtime`、それ以外は`agent`のCredential）。`usableCredentials`は有効（取消・期限切れでない）なものだけを渡す。
 * Credentialの一覧はadministratorしか取得できないため、それ以外では呼ばない。
 */
export const agentsWithoutCredential = (
  grants: readonly { principalId: string; role: string }[],
  usableCredentials: readonly { principalId: string; kind: "agent" | "runtime" }[],
): string[] => {
  const usable = new Set(usableCredentials.map((item) => `${item.kind}:${item.principalId}`));
  const missing = grants.filter((grant) => !usable.has(`${grant.role === "runtime" ? "runtime" : "agent"}:${grant.principalId}`)).map((grant) => grant.principalId);
  return [...new Set(missing)];
};
