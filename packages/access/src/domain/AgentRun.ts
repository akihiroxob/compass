import type { ProjectRole } from "./ProjectRole.ts";
import type { RoleScope } from "./RoleScope.ts";

/**
 * Agentの実行観測（run）。Ralph・Orchestratorが「このPrincipalがこのscope・activeRoleで実行を始めた・まだ観測できる・終わった」と
 * 報告した事実で、Agentプロセスの稼働を保証しない。Grant・Credential・Claimから導かず、Activity（意味のある履歴）や
 * workflow checkpointにも使わない。時刻はすべてServerが受け付けた時刻。
 */
export const agentRunSources = ["ralph", "orchestrator"] as const;
export type AgentRunSource = (typeof agentRunSources)[number];

/** 報告された作業の参照。Ralphの通常実行はAgentがTaskを選ぶため、開始時点では無い。 */
export const agentRunWorkKinds = ["task", "intent", "outcome", "evaluation", "research_request", "consultation"] as const;
export type AgentRunWorkKind = (typeof agentRunWorkKinds)[number];
export type AgentRunWorkRef = { kind: AgentRunWorkKind; id: string };

export type AgentRunStatus = "running" | "succeeded" | "failed";

/** 報告した主体。Agent Credential（Agent自身のPrincipal）か、Runtime Credential（Orchestrator等）。 */
export type AgentRunReporter = { kind: "agent" | "runtime"; principalId: string };

export type AgentRun = {
  runId: string;
  scope: RoleScope;
  principalId: string;
  role: ProjectRole;
  source: AgentRunSource;
  /** 報告元が申告した実行手段（claude・codex・コマンド名等）。自己申告で、実Agentの実行を証明しない。 */
  provider: string | null;
  workRef: AgentRunWorkRef | null;
  reporter: AgentRunReporter;
  status: AgentRunStatus;
  startedAt: number;
  /** 最後に開始・観測・終了の報告を受けた時刻。 */
  observedAt: number;
  /** 実行中のまま、この時刻を過ぎても報告が無ければ観測途絶とみなす。 */
  staleAt: number;
  endedAt: number | null;
  /** 終了理由（失敗時の終了コード・エラー等）。認証情報は伏字にして保存する。 */
  reason: string | null;
};

/**
 * 読取時点の観測状態。`running`は期限内に報告がある実行、`stale`は実行中のまま報告が途絶えた実行（稼働中と断定しない）。
 */
export type AgentRunObservation = "running" | "stale" | "succeeded" | "failed";
export const agentRunObservation = (run: Pick<AgentRun, "status" | "staleAt">, now: number): AgentRunObservation =>
  run.status === "running" ? (now >= run.staleAt ? "stale" : "running") : run.status;

/** 観測途絶とみなすまでの秒数の範囲。報告元が次の報告までの間隔に合わせて指定する。 */
export const agentRunStaleAfterSeconds = { min: 30, max: 24 * 60 * 60, default: 30 * 60 } as const;

const credentialPattern = /\bcmp_[A-Za-z0-9_.-]+/g;
const bearerPattern = /\b(Bearer)\s+[^\s"',;]+/gi;
/** 理由文に紛れた認証情報（Compass Credential・Bearer値）を伏字にする。報告元のエラー出力をそのまま保存・表示しない。 */
export const redactCredentials = (text: string): string =>
  text.replace(credentialPattern, "cmp_[redacted]").replace(bearerPattern, "$1 [redacted]");

export type AgentRunRecordResult =
  | { kind: "recorded"; run: AgentRun; changed: boolean }
  | { kind: "identity_mismatch"; run: AgentRun }
  | { kind: "not_found" }
  | { kind: "already_finished"; run: AgentRun };

export type AgentRunStart = Omit<AgentRun, "status" | "startedAt" | "observedAt" | "staleAt" | "endedAt" | "reason"> & { staleAfterMs: number };
export type AgentRunIdentity = Pick<AgentRun, "runId" | "scope" | "principalId" | "role">;

export interface AgentRunRepository {
  /** 開始。同じrunIdが同じPrincipal・scope・Roleで既にあれば変更せず返す（再送）。別の組合せなら`identity_mismatch`。 */
  start(input: AgentRunStart): Promise<AgentRunRecordResult>;
  /** 実行中の観測。終了済みには変更を加えず返す。 */
  observe(identity: AgentRunIdentity, staleAfterMs: number): Promise<AgentRunRecordResult>;
  /** 終了。同じ結果の再送は変更なし、終了済みへの別の結果は`already_finished`。 */
  finish(identity: AgentRunIdentity, status: Exclude<AgentRunStatus, "running">, reason: string | null): Promise<AgentRunRecordResult>;
  /** scopeごとに、Principal・Roleの組の最新の開始のrun。 */
  listLatest(scopes: readonly RoleScope[]): Promise<AgentRun[]>;
  /** あるPrincipalの、scope内の新しい順のrun。 */
  listByPrincipal(scopes: readonly RoleScope[], principalId: string, limit: number): Promise<AgentRun[]>;
}
