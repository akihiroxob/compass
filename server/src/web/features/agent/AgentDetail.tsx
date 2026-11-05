import { useState } from "react";
import { Link } from "react-router-dom";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button } from "../../components/ui";
import { projectViewPath, taskPath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { canOperateWorkspace } from "../access";
import { AgentCredentialDialog, CredentialRow, IssuedToken, type IssuedCredential } from "../credential";
import { formatTime, taskStatusLabels, taskStatusTones } from "../execution";
import { GrantRow, grantRoleLabels } from "../grant";
import type { HumanRole } from "../member";
import { AgentExecutionSection, AgentRunHistorySection } from "./AgentExecution";
import { AgentsToolbar, CredentialFact, IncompleteSources, RoleBadges, type AgentWorkspace } from "./AgentList";
import { AgentRegisterDialog } from "./AgentRegisterDialog";
import { agentListGaps, agentScopeGroups, claimsWithoutGrant, credentialBinding, type AgentScope, type WorkspaceAgent } from "./agents";
import { agentExecutionOf } from "./agentRuns";
import { useWorkspaceAgents, type LoadedWorkspaceAgents } from "./useWorkspaceAgents";

const scopeKindLabel = (scope: Pick<AgentScope, "kind">) => (scope.kind === "workspace" ? "Workspace" : "Project");
const scopeHome = (scope: AgentScope) => (scope.kind === "workspace" ? workspacePath(scope.id) : projectViewPath(scope.id, "overview"));

const ScopeLink = ({ scope }: { scope: AgentScope }) => (
  <Link to={scopeHome(scope)}><span className={statusBadgeClass("muted")}>{scopeKindLabel(scope)}</span> {scope.name}</Link>
);

/** 同一Principalが複数のGrantを持つ場合の、現在の契約と運用上の制約。既存のGrantは削除しない。 */
const MultipleGrantNote = ({ agent, now }: { agent: WorkspaceAgent; now: number }) => {
  const binding = credentialBinding(agent, now);
  if (agent.grants.length <= 1 && binding.kind !== "multiple") return null;
  return (
    <div className="fixed-note agent-contract-note" role="note">
      <p>このAgentには{agent.grants.length}件のGrantがあります。現在の契約では、1つのAgent名が複数のRole・複数のProjectのGrantを持てます。Agent管理の登録は1つのRoleを割り当てる運用を想定していますが、既存のGrantは自動では削除しません。不要なGrantは下の一覧から個別に取り消してください。</p>
      <p>1回の実行でAgentが担うRoleは1つ（activeRole）で、ServerがそのRoleのGrantを実行ごとに検証します。</p>
      {binding.kind === "multiple" && (
        <p>Agent Credentialは1つのWorkspaceまたはProjectに束縛されるため、複数のscope（{binding.scopes.map((scope) => scope.kind === "workspace" ? "Workspace" : scope.name).join("・")}）にGrant・有効なCredentialがあるこのAgentには新しく発行できません（trusted-local modeのAgent名による接続だけが使えます）。Credentialで接続する場合は、Grantを1つのscopeにするか、scopeごとに別のAgent名を登録してください。</p>
      )}
    </div>
  );
};

type DetailProps = { workspace: AgentWorkspace; agent: WorkspaceAgent; now: number; canManageGrant: boolean; canManageCredential: boolean; onChanged: () => void };

const GrantSection = ({ workspace, agent, now, canManageGrant, onChanged }: DetailProps) => {
  const groups = agentScopeGroups(agent).filter((group) => group.grants.length > 0);
  return (
    <section className="detail-section" aria-labelledby="agent-grants-heading">
      <h2 id="agent-grants-heading">Grant（Roleの割当）</h2>
      <p className="section-note">WorkspaceまたはProjectごとの割当で、このAgentが担当できるRoleを決めます。割当・取消はAgentを起動・停止しません。</p>
      <MultipleGrantNote agent={agent} now={now} />
      {groups.length === 0 ? <p className="unset">Grantはありません。このAgentはどのRoleも担当できません。</p> : groups.map(({ scope, grants }) => (
        <div key={`${scope.kind}/${scope.id}`} className="agent-scope-group">
          <h3><ScopeLink scope={scope} /></h3>
          <ul className="grant-list">
            {grants.map((grant) => (
              <GrantRow
                key={grant.role}
                scope={scope}
                grant={{ principalId: agent.principalId, role: grant.role, createdAt: grant.createdAt }}
                title={grantRoleLabels[grant.role]}
                readOnly={!canManageGrant || workspace.status === "archived"}
                actionsClassName="agent-pc-only"
                onRevoked={onChanged}
              />
            ))}
          </ul>
        </div>
      ))}
    </section>
  );
};

const CredentialsSection = ({ workspace, agent, now, canManageCredential, onChanged }: DetailProps) => {
  const [issuing, setIssuing] = useState(false);
  const [rotated, setRotated] = useState<IssuedCredential | null>(null);
  const binding = credentialBinding(agent, now);
  const groups = agentScopeGroups(agent).filter((group) => (group.credentials?.length ?? 0) > 0);
  const issueScope = binding.kind === "single" && workspace.status === "active" && canManageCredential ? binding.scope : null;
  return (
    <section className="detail-section" aria-labelledby="agent-credentials-heading">
      <div className="agent-section-head">
        <h2 id="agent-credentials-heading">Credential</h2>
        {issueScope && <span className="agent-pc-only"><Button variant="secondary" onClick={() => setIssuing(true)}>Credentialを発行</Button></span>}
      </div>
      <p className="section-note">AgentがMCPの <code>Authorization: Bearer &lt;token&gt;</code> に設定する資格です。発行したscopeだけで使え、そのscopeのGrantで認可されます。発行・取消はAgentを起動・停止しません。</p>
      {agent.credentials === null ? <p className="unset">Credentialの一覧・発行・取消は、Workspaceのadministrator以上が行います。</p> : (
        <>
          <p className="agent-credential-summary">代表の状態: <CredentialFact credential={agent.credential} /></p>
          {binding.kind === "none" && <p className="section-note">Grantも有効なCredentialも無いため、発行先のscopeがありません。先にRoleを割り当ててください。</p>}
          {binding.kind === "multiple" && <p className="section-note">複数のscopeにGrant・有効なCredentialがあるため、新しいAgent Credentialは発行できません（Grantの注記を参照）。</p>}
          {rotated && <IssuedToken issued={rotated} onDismiss={() => setRotated(null)} />}
          {groups.length === 0 ? <p className="unset">Agent Credentialはありません。</p> : groups.map(({ scope, credentials }) => (
            <ul key={`${scope.kind}/${scope.id}`} className="grant-list" aria-label={`${scope.name}のCredential`}>
              {(credentials ?? []).map((credential) => (
                <CredentialRow
                  key={credential.id}
                  scope={credential.scope}
                  credential={credential}
                  title={`${scopeKindLabel(scope)} · ${scope.name}`}
                  readOnly={workspace.status === "archived"}
                  actionsClassName="agent-pc-only"
                  onChanged={onChanged}
                  onRotated={(issued) => { setRotated(issued); onChanged(); }}
                />
              ))}
            </ul>
          ))}
          {issueScope && <AgentCredentialDialog open={issuing} onClose={() => setIssuing(false)} scope={issueScope} principalId={agent.principalId} onIssued={onChanged} />}
        </>
      )}
    </section>
  );
};

/** 担当（Role・担当範囲）と実行状況（報告された観測）。実行状況はGrant・Credential・Claimから推測しない。 */
const scopeNameOf = (workspace: AgentWorkspace, loaded: LoadedWorkspaceAgents) => (scope: { kind: "workspace" | "project"; id: string }) =>
  scope.kind === "workspace" ? (scope.id === workspace.id ? workspace.name : scope.id) : (loaded.projects.find((project) => project.id === scope.id)?.name ?? scope.id);

const Overview = ({ workspace, agent, loaded }: { workspace: AgentWorkspace; agent: WorkspaceAgent; loaded: LoadedWorkspaceAgents }) => {
  const scopeName = scopeNameOf(workspace, loaded);
  return (
    <div className="agent-detail-grid">
      <section className="detail-section" aria-labelledby="agent-assignment-heading">
        <h2 id="agent-assignment-heading">担当</h2>
        <dl className="agent-facts">
          <div><dt>Role</dt><dd><RoleBadges agent={agent} /></dd></div>
          <div>
            <dt>担当範囲（{agent.scopes.length}件）</dt>
            <dd>{agent.scopes.length ? <ul className="agent-scope-links">{agent.scopes.map((scope) => <li key={`${scope.kind}/${scope.id}`}><ScopeLink scope={scope} /></li>)}</ul> : <span className="unset">担当範囲なし</span>}</dd>
          </div>
        </dl>
      </section>
      <AgentExecutionSection execution={agentExecutionOf(agent.principalId, loaded.runs)} scopeName={scopeName} />
    </div>
  );
};

const ClaimSection = ({ agent }: { agent: WorkspaceAgent }) => {
  const orphaned = claimsWithoutGrant(agent);
  return (
    <section className="detail-section" aria-labelledby="agent-claims-heading">
      <h2 id="agent-claims-heading">現在の作業（Claim）</h2>
      <p className="section-note">Taskの作業・レビュー・受入の期限付きの保持です。Agentプロセスの稼働を示しません。</p>
      {agent.claims.length === 0 ? <p className="unset">保持中のClaimはありません。</p> : (
        <ul className="grant-list">
          {agent.claims.map((claim) => (
            <li key={claim.taskId}>
              <div>
                <Link to={taskPath(claim.projectId, claim.taskId)}>{claim.title}</Link>
                <small><span className={statusBadgeClass(taskStatusTones[claim.status])}>{taskStatusLabels[claim.status]}</span> {claim.projectName} · 期限 {formatTime(claim.expiresAt)}</small>
              </div>
            </li>
          ))}
        </ul>
      )}
      {orphaned.length > 0 && <p className="agent-warning">{orphaned.length}件のClaimは、そのProjectで対応するRoleのGrantが現在ありません（Claim取得後に取り消された可能性があります）。</p>}
    </section>
  );
};

/**
 * WorkspaceのAgent詳細。担当（Role・全担当範囲）・実行状況・現在の作業・Grant・scope別のCredentialを分けて出し、
 * Roleの追加・Grantの取消・Credentialの発行・rotation・取消を行う（PCだけに導線を置き、認可はserverが行う）。
 */
export const WorkspaceAgentDetail = ({ workspace, myRole, principalId }: { workspace: AgentWorkspace; myRole: HumanRole; principalId: string }) => {
  const { loaded, error, pending, reload } = useWorkspaceAgents(workspace, myRole);
  const [assigning, setAssigning] = useState(false);
  const canManageGrant = workspace.status === "active" && canOperateWorkspace(myRole, "grant.manage");
  const canManageCredential = canOperateWorkspace(myRole, "credential.manage");
  const agent = loaded?.agents.principals.find((candidate) => candidate.principalId === principalId) ?? null;
  return (
    <>
      <nav className="breadcrumb" aria-label="現在位置">
        <ol>
          <li><Link to={workspacePath(workspace.id)}>{workspace.name}</Link></li>
          <li><Link to={workspacePath(workspace.id, "agents")}>Agent管理</Link></li>
          <li aria-current="page">{principalId}</li>
        </ol>
      </nav>
      <AgentsToolbar fetchedAt={loaded?.fetchedAt ?? null} pending={pending} onReload={reload}>
        {canManageGrant && agent && <span className="agent-pc-only"><Button size="md" onClick={() => setAssigning(true)}>Roleを割り当てる</Button></span>}
      </AgentsToolbar>
      {error ? <ErrorState message={`Agentの読み込みに失敗しました: ${error}`} /> : !loaded ? <Loading /> : (
        <>
          <IncompleteSources gaps={agentListGaps(loaded)} />
          {!agent && agentListGaps(loaded).length > 0 ? (
            <StateCard>
              <p><code>{principalId}</code> の情報を取得できませんでした。読み込めなかった情報（上記）にだけ含まれるAgentの可能性があり、存在しないとは断定できません。再読込してください。</p>
              <p><Link to={workspacePath(workspace.id, "agents")} className="text-link">Agent管理の一覧へ →</Link></p>
            </StateCard>
          ) : !agent ? (
            <StateCard>
              <p>このWorkspaceに <code>{principalId}</code> というAgentは見つかりません。Grant・期限内のClaim・有効なCredential・実行観測がすべて無いAgentは表示されません。</p>
              <p><Link to={workspacePath(workspace.id, "agents")} className="text-link">Agent管理の一覧へ →</Link></p>
            </StateCard>
          ) : (
            <>
              <Overview workspace={workspace} agent={agent} loaded={loaded} />
              <ClaimSection agent={agent} />
              <AgentRunHistorySection workspaceId={workspace.id} principalId={agent.principalId} reloadKey={loaded.fetchedAt} scopeName={scopeNameOf(workspace, loaded)} />
              <GrantSection workspace={workspace} agent={agent} now={loaded.fetchedAt} canManageGrant={canManageGrant} canManageCredential={canManageCredential} onChanged={reload} />
              <CredentialsSection workspace={workspace} agent={agent} now={loaded.fetchedAt} canManageGrant={canManageGrant} canManageCredential={canManageCredential} onChanged={reload} />
              {canManageGrant && (
                <AgentRegisterDialog open={assigning} onClose={() => setAssigning(false)} workspace={workspace} projects={loaded.projects} principalId={agent.principalId} onChanged={reload} onRegistered={() => undefined} />
              )}
            </>
          )}
        </>
      )}
    </>
  );
};
