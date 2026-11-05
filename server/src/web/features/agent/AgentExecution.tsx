import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { request, settle } from "../../api";
import { consultationPath, taskPath, workspaceConsultationPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { formatTime } from "../execution";
import { grantRoleLabels } from "../grant";
import {
  agentExecutionLabels,
  agentExecutionReason,
  agentExecutionTones,
  agentRunObservationLabels,
  agentRunSourceLabels,
  agentRunsPath,
  agentRunWorkKindLabels,
  type AgentExecution,
  type AgentRun,
  type AgentRuns,
} from "./agentRuns";

/** 実行状況が観測であることの注記。一覧の冒頭・詳細の節で共通に使う。 */
export const executionObservationNote =
  "実行状況はRalph・Orchestratorが報告した実行の開始・観測・終了で、Agentプロセスの稼働を保証しません。Role割当・Credential・Claimからは推測しません。報告元・providerはRunnerの申告で、自律運転の実証ではありません。";

export const ExecutionBadge = ({ execution }: { execution: AgentExecution }) => (
  <span className={statusBadgeClass(agentExecutionTones[execution.kind])}>{agentExecutionLabels[execution.kind]}</span>
);

/** 一覧カードの実行状況（badge・観測時刻と理由）。 */
export const ExecutionFact = ({ execution }: { execution: AgentExecution }) => (
  <>
    <ExecutionBadge execution={execution} />
    <small className="agent-execution-reason">{agentExecutionReason(execution, formatTime)}</small>
  </>
);

const roleLabel = (role: string) => grantRoleLabels[role as keyof typeof grantRoleLabels] ?? role;

/** 報告された作業の参照。Task・相談は画面へ辿り、それ以外は種別とIDを出す。 */
const WorkRef = ({ run }: { run: AgentRun }) => {
  if (run.workRef === null) return <span className="unset">報告なし（Agentが選ぶ作業は現在の作業（Claim）を参照）</span>;
  const label = `${agentRunWorkKindLabels[run.workRef.kind]} ${run.workRef.id}`;
  if (run.workRef.kind === "task" && run.scope.kind === "project") return <Link to={taskPath(run.scope.id, run.workRef.id)}>{label}</Link>;
  if (run.workRef.kind === "consultation") {
    return <Link to={run.scope.kind === "project" ? consultationPath(run.scope.id, run.workRef.id) : workspaceConsultationPath(run.scope.id, run.workRef.id)}>{label}</Link>;
  }
  return <code>{label}</code>;
};

/** run 1件の根拠（Role・scope・run ID・報告元・作業・時刻・終了理由）。 */
const RunFacts = ({ run, scopeName }: { run: AgentRun; scopeName: (scope: AgentRun["scope"]) => string }) => (
  <dl className="agent-run-facts">
    <div><dt>Role・範囲</dt><dd>{roleLabel(run.role)} · {run.scope.kind === "workspace" ? "Workspace" : "Project"} {scopeName(run.scope)}</dd></div>
    <div><dt>run</dt><dd><code>{run.runId}</code></dd></div>
    <div><dt>報告元</dt><dd>{agentRunSourceLabels[run.source]}{run.provider && ` · ${run.provider}`} · {run.reporter.kind === "agent" ? "Agent Credential" : `Runtime ${run.reporter.principalId}`}</dd></div>
    <div><dt>作業</dt><dd><WorkRef run={run} /></dd></div>
    <div><dt>開始・最終観測</dt><dd>{formatTime(run.startedAt)} · {formatTime(run.observedAt)}</dd></div>
    {run.endedAt !== null && <div><dt>終了</dt><dd>{formatTime(run.endedAt)}{run.reason && ` · ${run.reason}`}</dd></div>}
  </dl>
);

/** このPrincipalの実行履歴（新しい順・最大20件）。再読込のたびに読み直し、取得不能は空と区別する。 */
const useRunHistory = (workspaceId: string, principalId: string, reloadKey: number) => {
  const [state, setState] = useState<{ key: string; result: { ok: true; value: AgentRuns } | { ok: false; error: string } } | null>(null);
  const key = `${workspaceId}/${principalId}/${reloadKey}`;
  useEffect(() => {
    let current = true;
    void settle(request<AgentRuns>(agentRunsPath(workspaceId, principalId)), "実行観測を読む権限がありません。").then((result) => {
      if (current) setState({ key, result });
    });
    return () => { current = false; };
  }, [key, workspaceId, principalId]);
  return state?.key === key ? state.result : null;
};

/** Agent詳細の実行状況。代表の状態と根拠を出す。Grant・Credential・Claimは別の節で、ここからは参照しない。 */
export const AgentExecutionSection = ({ execution, scopeName }: { execution: AgentExecution; scopeName: (scope: AgentRun["scope"]) => string }) => (
  <section className="detail-section" aria-labelledby="agent-execution-heading">
    <h2 id="agent-execution-heading">実行状況</h2>
    <p className="agent-execution-state"><ExecutionBadge execution={execution} /> {agentExecutionReason(execution, formatTime)}</p>
    {"run" in execution && <RunFacts run={execution.run} scopeName={scopeName} />}
    <p className="section-note">{executionObservationNote}</p>
  </section>
);

/** このPrincipalの実行の履歴（新しい順・最大20件）。根拠のrunを辿るための一覧で、取得不能は空と区別する。 */
export const AgentRunHistorySection = ({ workspaceId, principalId, reloadKey, scopeName }: {
  workspaceId: string;
  principalId: string;
  /** 一覧の再読込と同時に履歴も読み直すための値（取得時刻）。 */
  reloadKey: number;
  scopeName: (scope: AgentRun["scope"]) => string;
}) => {
  const history = useRunHistory(workspaceId, principalId, reloadKey);
  return (
    <section className="detail-section" aria-labelledby="agent-runs-heading">
      <h2 id="agent-runs-heading">実行の履歴</h2>
      <p className="section-note">Runnerが報告した実行（新しい順・最大20件）。業務の経緯（Activity）とは別の記録です。</p>
      {history === null ? <p className="unset">読み込み中...</p> : !history.ok ? (
        <p className="agent-warning" role="alert">実行の履歴を取得できませんでした: {history.error}</p>
      ) : history.value.runs.length === 0 ? <p className="unset">報告された実行はありません。</p> : (
        <ul className="agent-run-list" aria-label="実行の履歴">
          {history.value.runs.map((run) => (
            <li key={run.runId}>
              <span className={statusBadgeClass(agentExecutionTones[run.observation])}>{agentRunObservationLabels[run.observation]}</span>
              <RunFacts run={run} scopeName={scopeName} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
};
