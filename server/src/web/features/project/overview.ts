// Project詳細の概要（Task 03）の判定。表示から分けた純関数で、導線の表示だけを決める（拒否は常にserverが行う）。
// テストからも読み込むため、他moduleをimportしない（Task・Outcomeの段・Credentialは構造だけを受け取る）。

/** 判定に使うTaskの項目（Executionの`ExecutionTask`の一部）。 */
export type OverviewTask = {
  id: string;
  status: "todo" | "doing" | "in_review" | "wait_accept" | "accepted" | "rejected" | "canceled";
  activeClaim: { expiresAt: number } | null;
};
/** Executionの`outcomeLoopStage`の段。 */
export type OverviewStage = { stage: "not_connected" | "not_reflected" | "not_evaluated" | "evaluated" };
/** 概要で判定に使うAgentのRole。 */
export type OverviewRole = "manager" | "worker" | "reviewer" | "evaluator" | "runtime";

// ---- Project詳細のview（Task 03）。`?view=`で表し、再読込・共有・戻るで同じviewへ戻る。 ----

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

// ---- 次の行動 ----

export type OverviewOutcome = { id: string; intentId: string; title: string };
/** Active Outcomeごとの閉ループの現在地。取得に失敗したOutcomeは`stage: null`。 */
export type OutcomeProgress = { outcome: OverviewOutcome; stage: OverviewStage | null; tasks: readonly OverviewTask[] };

export type OverviewPermissions = { directionWrite: boolean; intervene: boolean; grantManage: boolean; credentialManage: boolean };

export type MyAction =
  | { kind: "intent" | "outcome"; label: string; allowed: boolean; requestTo: string }
  | { kind: "accept"; label: string; allowed: true; taskId: string }
  | { kind: "grant"; role: OverviewRole; label: string; allowed: boolean; requestTo: string }
  | { kind: "credential"; label: string; allowed: true; principalIds: readonly string[] };

export type WaitingKind = "story" | "evaluation" | "reflection" | "todo" | "rejected" | "reclaimable" | "in_review" | "wait_accept";
export type WaitingItem = {
  kind: WaitingKind;
  count: number;
  /** 次に動く担当（Role）と、その説明。 */
  role: OverviewRole;
  note: string;
  unassigned: boolean;
  /** 根拠の詳細。OutcomeはOutcome詳細、Taskは「実行」viewの該当Task。 */
  outcomes: OverviewOutcome[];
  taskIds: string[];
};

export type NextActions = { mine: MyAction[]; waiting: WaitingItem[]; outcomeFailures: number };

export type NextActionInput = {
  activeIntentId: string | null;
  /** Active Intentが無ければ空。 */
  outcomes: readonly OutcomeProgress[];
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
  evaluator: "Evaluator",
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

/** OutcomeのTaskに、まだ動く必要のあるもの（未着手・差戻し・作業中・再取得待ち・レビュー待ち・受入待ち）が残るか。 */
const hasOpenTask = (tasks: readonly OverviewTask[], now: number) => tasks.some((task) => workBucket(task, now) !== null);

/**
 * 概要の「次の行動」。「あなたの操作」は条件を上から評価して最大3件、権限が無いものは依頼先にする（Humanが代行できない担当待ちはボタンにしない）。
 * 「Agentの担当待ち」はOutcomeを`outcomeOverviewStage`、Taskを期限内Claimの有無で判定する。archivedでは呼ばない。
 */
export const planNextActions = (input: NextActionInput): NextActions => {
  const { outcomes, tasks, assignedRoles, permissions, now } = input;
  const loaded = outcomes.filter((item): item is OutcomeProgress & { stage: OverviewStage } => item.stage !== null);
  const outcomesAt = (stage: OverviewStage["stage"]) => loaded.filter((item) => item.stage.stage === stage);
  const reflection = outcomesAt("not_reflected").filter((item) => !hasOpenTask(item.tasks, now));
  const waitingTasks = tasks.filter((task) => !holdsClaim(task, now));
  const tasksIn = (bucket: WorkBucket) => waitingTasks.filter((task) => workBucket(task, now) === bucket);

  const outcomeWaiting = (kind: WaitingKind, role: OverviewRole, note: string, items: typeof loaded): WaitingItem =>
    ({ kind, count: items.length, role, note, unassigned: !assignedRoles.has(role), outcomes: items.map((item) => item.outcome), taskIds: [] });
  const waiting = [
    outcomeWaiting("story", "manager", "Managerの起票待ち", outcomesAt("not_connected")),
    outcomeWaiting("evaluation", "evaluator", "Evaluatorの評価待ち", outcomesAt("not_evaluated")),
    outcomeWaiting("reflection", "runtime", "Runtimeの結果還流待ち", reflection),
    ...taskWaiting.map(({ kind, role, note }): WaitingItem => {
      const matched = tasksIn(kind);
      return { kind, count: matched.length, role, note, unassigned: !assignedRoles.has(role), outcomes: [], taskIds: matched.map((task) => task.id) };
    }),
  ].filter((item) => item.count > 0);

  const grant = (role: OverviewRole, needed: boolean): MyAction[] =>
    needed && !assignedRoles.has(role) ? [{ kind: "grant", role, label: `${roleNames[role]}を割り当てる`, allowed: permissions.grantManage, requestTo: "Administrator以上へ依頼" }] : [];
  const acceptable = tasksIn("wait_accept");
  const mine: MyAction[] = [
    ...(input.activeIntentId === null ? [{ kind: "intent", label: "Intentを登録", allowed: permissions.directionWrite, requestTo: "Editor以上へ依頼" } as const] : []),
    ...(input.activeIntentId !== null && outcomes.length === 0 ? [{ kind: "outcome", label: "Outcomeを登録", allowed: permissions.directionWrite, requestTo: "Editor以上へ依頼" } as const] : []),
    ...(acceptable.length && permissions.intervene ? [{ kind: "accept", label: `受入待ちのTaskを確認（${acceptable.length}件）`, allowed: true, taskId: acceptable[0]!.id } as const] : []),
    ...grant("manager", outcomesAt("not_connected").length > 0),
    ...grant("worker", tasksIn("todo").length + tasksIn("rejected").length + tasksIn("reclaimable").length > 0),
    ...grant("reviewer", tasks.some((task) => task.status === "in_review")),
    ...(permissions.credentialManage && input.agentsWithoutCredential?.length
      ? [{ kind: "credential", label: "Credentialを発行", allowed: true, principalIds: input.agentsWithoutCredential } as const]
      : []),
    ...grant("evaluator", outcomesAt("not_evaluated").length > 0),
  ];
  return { mine: mine.slice(0, maxMyActions), waiting, outcomeFailures: outcomes.length - loaded.length };
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
