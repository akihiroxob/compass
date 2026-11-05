import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button } from "../../components/ui";
import { taskPath, workspaceAgentPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { canOperateWorkspace } from "../access";
import { credentialStatusTones } from "../credential";
import { formatTime, taskStatusLabels, taskStatusTones } from "../execution";
import { grantRoleLabels } from "../grant";
import type { HumanRole } from "../member";
import { ExecutionFact, executionObservationNote } from "./AgentExecution";
import { AgentRegisterDialog } from "./AgentRegisterDialog";
import { AgentRoleSection } from "./AgentRoles";
import { agentExecutionOf, type AgentExecution } from "./agentRuns";
import { principalCredentialLabels, scopeSummary, workspaceAgentRoles, type PrincipalCredential, type WorkspaceAgent } from "./agents";
import { useWorkspaceAgents, type LoadedWorkspaceAgents } from "./useWorkspaceAgents";

export type AgentWorkspace = { id: string; name: string; status: "active" | "archived" };

/** 取得時刻・再読込。ページ全体の操作（登録等）は`children`で同じ列に置く。 */
export const AgentsToolbar = ({ fetchedAt, pending, onReload, children }: { fetchedAt: number | null; pending: boolean; onReload: () => void; children?: ReactNode }) => (
  <div className="list-toolbar agent-toolbar">
    <span className="agent-fetched-at">{fetchedAt === null ? "未取得" : `${formatTime(fetchedAt)} 取得`}</span>
    <Button variant="secondary" size="md" pending={pending} onClick={onReload}>{pending ? "読み込み中..." : "再読込"}</Button>
    {children}
  </div>
);

/** 読み込めなかったProject。そのProjectのGrant・Credential・Claimは含まれていないため、0件・なしと断定しない。 */
export const FailedProjects = ({ loaded }: { loaded: LoadedWorkspaceAgents }) =>
  loaded.failedProjects.length === 0 ? null : (
    <StateCard tone="error" role="alert">
      <p className="error-title">{loaded.failedProjects.length}件のProjectを読み込めませんでした</p>
      <ul>{loaded.failedProjects.map(({ project, error }) => <li key={project.id}>{project.name}: {error}</li>)}</ul>
      <p>これらのProjectのRole割当・Credential・Claimは表示に含まれていません。再読込してください。</p>
    </StateCard>
  );

export const CredentialFact = ({ credential }: { credential: PrincipalCredential | null }) =>
  credential === null ? <span className="unset">Workspaceのadministrator以上が確認できます</span> : (
    <>
      <span className={statusBadgeClass(credential.status === "none" ? "waiting" : credentialStatusTones[credential.status])}>{principalCredentialLabels[credential.status]}</span>
      {credential.status === "active" && credential.expiresAt !== null && <small>期限 {formatTime(credential.expiresAt)}</small>}
    </>
  );

export const RoleBadges = ({ agent }: { agent: Pick<WorkspaceAgent, "roles"> }) =>
  agent.roles.length ? (
    <span className="agent-roles">{agent.roles.map((role) => <span key={role} className={statusBadgeClass("muted")}>{grantRoleLabels[role]}</span>)}</span>
  ) : <span className="unset">Grantなし（担当できるRoleはありません）</span>;

/** Workspace Roleだけを持ち、Work Claimを取らないAgentか。 */
const directionOnly = (agent: WorkspaceAgent) => agent.claims.length === 0 && agent.roles.length > 0 && agent.roles.every((role) => workspaceAgentRoles.some((candidate) => candidate === role));

/** 一覧の1件。担当範囲はProject名1件と「ほかN件」の1行で、全件は詳細で出す。 */
const AgentCard = ({ workspaceId, agent, execution }: { workspaceId: string; agent: WorkspaceAgent; execution: AgentExecution }) => {
  const summary = scopeSummary(agent.scopes);
  const [claim, ...otherClaims] = agent.claims;
  return (
    <li className="agent-card">
      <div className="agent-card-main">
        <h2><Link to={workspaceAgentPath(workspaceId, agent.principalId)}>{agent.principalId}</Link></h2>
        <RoleBadges agent={agent} />
        <p className="agent-card-scope" aria-label="担当範囲">
          {summary ? <><span className="agent-scope-name" title={summary.label}>{summary.label}</span>{summary.others > 0 && <span className="agent-scope-others">ほか{summary.others}件</span>}</> : <span className="unset">担当範囲なし</span>}
        </p>
      </div>
      <dl className="agent-card-facts">
        <div><dt>実行状況</dt><dd><ExecutionFact execution={execution} /></dd></div>
        <div><dt>Credential</dt><dd><CredentialFact credential={agent.credential} /></dd></div>
        <div>
          <dt>現在の作業（Claim）</dt>
          <dd>
            {claim ? (
              <>
                <Link to={taskPath(claim.projectId, claim.taskId)}>{claim.title}</Link>
                <small><span className={statusBadgeClass(taskStatusTones[claim.status])}>{taskStatusLabels[claim.status]}</span> {claim.projectName}{otherClaims.length > 0 && ` · ほか${otherClaims.length}件`}</small>
              </>
            ) : <span className="unset">{directionOnly(agent) ? "Claimを持たないRoleです" : "保持中のClaimはありません"}</span>}
          </dd>
        </div>
      </dl>
    </li>
  );
};

/**
 * WorkspaceのAgent管理（一覧）。Principalごとに、Role・担当範囲・実行状況（報告された観測）・Credential・現在の作業（Claim）を分けて出す。
 * 登録はPCの画面上部に置き（狭い画面では出さない）、表示の有無は導線だけで、認可はserverが行う。
 */
export const WorkspaceAgentList = ({ workspace, myRole }: { workspace: AgentWorkspace; myRole: HumanRole }) => {
  const { loaded, error, pending, reload } = useWorkspaceAgents(workspace, myRole);
  const [registering, setRegistering] = useState(false);
  const navigate = useNavigate();
  const canRegister = workspace.status === "active" && canOperateWorkspace(myRole, "grant.manage");
  return (
    <>
      <div className="fixed-note agent-intro">
        <p><strong>Role</strong>はAgentの責務、<strong>Grant</strong>はWorkspaceまたはProjectでそのRoleを担当できる割当、<strong>Credential</strong>はAgentがCompassへ接続する資格、<strong>Claim</strong>はAgentが今保持しているTaskの期限付きの作業権です。</p>
        <p>{executionObservationNote}</p>
      </div>
      <AgentsToolbar fetchedAt={loaded?.fetchedAt ?? null} pending={pending} onReload={reload}>
        {canRegister && loaded && <span className="agent-pc-only"><Button size="md" onClick={() => setRegistering(true)}>Agentを登録</Button></span>}
      </AgentsToolbar>
      {error ? <ErrorState message={`Agentの読み込みに失敗しました: ${error}`} /> : !loaded ? <Loading /> : (
        <>
          <FailedProjects loaded={loaded} />
          {loaded.agents.principals.length ? (
            <ul className="agent-list" aria-label="Agent">
              {loaded.agents.principals.map((agent) => <AgentCard key={agent.principalId} workspaceId={workspace.id} agent={agent} execution={agentExecutionOf(agent.principalId, loaded.runs)} />)}
            </ul>
          ) : (
            <StateCard>
              <p>このWorkspaceと、activeな所属ProjectにAgentは登録されていません。</p>
              {canRegister && <p className="agent-pc-only">「Agentを登録」でAgent名にRoleを割り当てます。</p>}
            </StateCard>
          )}
          {loaded.agents.reclaimableCount > 0 && (
            <p className="claim-holder-reclaimable"><span className={statusBadgeClass("warning")}>再取得待ち</span> {loaded.agents.reclaimableCount}件 — Claimの期限が切れ、Workerの再取得待ちのTaskです（担当中ではありません）</p>
          )}
          {canRegister && (
            <AgentRegisterDialog
              open={registering}
              onClose={() => setRegistering(false)}
              workspace={workspace}
              projects={loaded.projects}
              onChanged={reload}
              onRegistered={(principalId) => navigate(workspaceAgentPath(workspace.id, principalId))}
            />
          )}
        </>
      )}
      <AgentRoleSection />
    </>
  );
};
