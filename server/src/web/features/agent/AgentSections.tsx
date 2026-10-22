import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { projectViewPath, taskPath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { canOperate, canOperateWorkspace } from "../access";
import { credentialsPath, credentialStatusTones, scopeCredentialsPath, type Credential } from "../credential";
import { executionPath, formatTime, taskStatusLabels, taskStatusTones, type ExecutionOverview } from "../execution";
import { agentRoleAnchorId, agentRoleDescriptions, grantRoleLabels, grantsPath, scopeGrantsPath, type AgentRole } from "../grant";
import type { HumanRole } from "../member";
import {
  agentRolePath,
  claimsWithoutGrant,
  principalCredentialLabels,
  projectAgentRoles,
  summarizeScopeAgents,
  workspaceAgentRoles,
  type AgentPrincipal,
  type AgentRoleDefinition,
  type ScopeAgents,
  type ScopeGrant,
} from "./agents";

type Loaded = { agents: ScopeAgents; fetchedAt: number };

/** scope 1つ分の読込。`load`は取得時刻を`now`に使う。再読込中は前の結果を残し、失敗は空と区別する。 */
const useScopeAgents = (key: string, load: (now: number) => Promise<ScopeAgents>, notFound: string) => {
  const [state, setState] = useState<{ key: string; loaded: Loaded | null; error: string | null; pending: boolean } | null>(null);
  const reload = useCallback((isCurrent: () => boolean = () => true) => {
    setState((current) => ({ key, loaded: current?.key === key ? current.loaded : null, error: null, pending: true }));
    const fetchedAt = Date.now();
    return load(fetchedAt)
      .then((agents) => { if (isCurrent()) setState({ key, loaded: { agents, fetchedAt }, error: null, pending: false }); })
      .catch((reason: unknown) => { if (isCurrent()) setState({ key, loaded: null, error: loadFailureMessage(classifyError(reason), notFound), pending: false }); });
  }, [key]);
  useEffect(() => {
    let current = true;
    void reload(() => current);
    return () => { current = false; };
  }, [reload]);
  return state?.key === key ? { ...state, reload } : { loaded: null, error: null, pending: true, reload };
};

const Toolbar = ({ fetchedAt, pending, onReload }: { fetchedAt: number | null; pending: boolean; onReload: () => void }) => (
  <div className="claim-holder-toolbar">
    <span>{fetchedAt === null ? "未取得" : `${formatTime(fetchedAt)} 取得`}</span>
    <button type="button" className="secondary-button compact" disabled={pending} onClick={onReload}>{pending ? "読み込み中..." : "再読込"}</button>
  </div>
);

/** Role DefinitionとSkillのmetadata。開いたときだけ取得する（Progressive Disclosure）。 */
const RoleDefinitionDetails = ({ role }: { role: AgentRole }) => {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ definition: AgentRoleDefinition | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!open || state?.definition) return;
    let current = true;
    setState(null);
    request<AgentRoleDefinition>(agentRolePath(role))
      .then((definition) => { if (current) setState({ definition, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ definition: null, error: loadFailureMessage(classifyError(reason), "Role Definitionが見つかりません。") }); });
    return () => { current = false; };
  }, [open, role]);
  const definition = state?.definition;
  return (
    <details className="role-definition" onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Role定義とSkill</summary>
      {state?.error ? <ErrorState message={`Role定義の読み込みに失敗しました: ${state.error}`} /> : !definition ? (open ? <Loading /> : null) : (
        <>
          <p className="role-definition-source">
            <code>{definition.role.path}</code>
            {definition.source.revision ? <> · revision <code>{definition.source.revision.slice(0, 12)}</code></> : " · revisionは取得できません"}
            {definition.source.dirty && " · 未commitの変更あり"}
          </p>
          <h4>このRoleが参照するSkill</h4>
          {definition.skills.length ? (
            <ul className="role-skills">
              {definition.skills.map((skill) => (
                <li key={skill.name}>
                  <div><strong>{skill.name}</strong> <small>v{skill.version}</small>{skill.status !== "active" && <> <span className={statusBadgeClass("muted")}>{skill.status}</span></>}</div>
                  <p>{skill.description}</p>
                  <small><code>{skill.path}</code>{skill.requiredKnowledge.length > 0 && ` · Knowledge ${skill.requiredKnowledge.length}件`}</small>
                </li>
              ))}
            </ul>
          ) : <p className="unset">Role定義からSkillを参照していません。</p>}
          <p className="section-note">Skillは手順で、権限はGrantで決まります。Skillの本文はAgentがMCPの <code>get_skill_context</code> で必要時に取得します。</p>
          <details className="role-definition-body">
            <summary>Role定義の本文</summary>
            <p className="pre-wrap">{definition.role.content.trim()}</p>
          </details>
        </>
      )}
    </details>
  );
};

/** Roleの責務・担当できるAgent（Grant）・Role定義への導線。`principalIds`を省くとRoleの説明だけを出す。 */
const RoleList = ({ roles, principalIds }: { roles: readonly AgentRole[]; principalIds?: ReadonlyMap<AgentRole, string[]> }) => (
  <ul className="agent-role-cards">
    {roles.map((role) => {
      const ids = principalIds?.get(role);
      return (
        <li key={role}>
          <div className="agent-role-card-head"><strong>{grantRoleLabels[role]}</strong><span>{agentRoleDescriptions[role]}</span></div>
          {ids && <p className="agent-role-card-agents">担当できるAgent: {ids.length ? ids.map((id, index) => <span key={id}>{index > 0 && "、"}<code>{id}</code></span>) : <span className="unset">未割当</span>}</p>}
          <RoleDefinitionDetails role={role} />
        </li>
      );
    })}
  </ul>
);

const Fact = ({ label, children }: { label: string; children: ReactNode }) => <div><dt>{label}</dt><dd>{children}</dd></div>;

/** Principal 1件の、Grant・Credential・Claimを別々の項目で出す。いずれもAgentプロセスの稼働を示さない。 */
const PrincipalRow = ({ principal, credentialHint }: { principal: AgentPrincipal; credentialHint: string }) => {
  const { credential, claims } = principal;
  const orphaned = claimsWithoutGrant(principal);
  return (
    <li>
      <p className="agent-principal-id"><code>{principal.principalId}</code></p>
      <dl className="agent-principal-facts">
        <Fact label="担当できるRole（Grant）">
          {principal.roles.length ? <span className="agent-principal-roles">{principal.roles.map((role) => <span key={role} className={statusBadgeClass("muted")}>{grantRoleLabels[role]}</span>)}</span> : <span className="unset">Grantなし（担当できません）</span>}
        </Fact>
        <Fact label="Credential">
          {credential === null ? <span className="unset">{credentialHint}</span> : (
            <>
              <span className={statusBadgeClass(credential.status === "none" ? "waiting" : credentialStatusTones[credential.status])}>{principalCredentialLabels[credential.status]}</span>
              {credential.status === "active" && credential.expiresAt !== null && <small>期限 {formatTime(credential.expiresAt)}</small>}
            </>
          )}
        </Fact>
        <Fact label="保持中のClaim">
          {claims === null ? <span className="unset">Work Claimを持ちません</span> : claims.length === 0 ? <span className="unset">なし</span> : (
            <ul className="agent-principal-claims">
              {claims.map((claim) => (
                <li key={claim.taskId}>
                  <Link to={taskPath(claim.projectId, claim.taskId)}>{claim.title}</Link>
                  <small><span className={statusBadgeClass(taskStatusTones[claim.status])}>{taskStatusLabels[claim.status]}</span> 期限 {formatTime(claim.expiresAt)}</small>
                </li>
              ))}
            </ul>
          )}
          {orphaned.length > 0 && <small className="agent-principal-warning">{orphaned.length}件のClaimは、対応するRoleのGrantが現在ありません（Claim取得後に取り消された可能性があります）。</small>}
        </Fact>
      </dl>
    </li>
  );
};

const PrincipalList = ({ agents, empty, credentialHint }: { agents: ScopeAgents; empty: string; credentialHint: string }) =>
  agents.principals.length ? (
    <ul className="agent-principals">{agents.principals.map((principal) => <PrincipalRow key={principal.principalId} principal={principal} credentialHint={credentialHint} />)}</ul>
  ) : <p className="unset">{empty}</p>;

const principalIdsByRole = (agents: ScopeAgents) => new Map(agents.roles.map(({ role, principalIds }) => [role, principalIds]));

const workspaceNotFound = "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。";

/**
 * WorkspaceのDirection Role（Strategist・Researcher・Evaluator）。Workspace GrantとWorkspace Credentialだけから表示し、
 * Project Grantから継承しない。Direction RoleはWork Claimを持たないため、保持中のTaskを作らない。
 */
export const WorkspaceAgentsSection = ({ workspace, myRole }: { workspace: { id: string }; myRole: HumanRole }) => {
  const showCredentials = canOperateWorkspace(myRole, "credential.manage");
  const { loaded, error, pending, reload } = useScopeAgents(
    `${workspace.id}/${showCredentials}`,
    (now) =>
      Promise.all([
        request<{ grants: ScopeGrant[] }>(scopeGrantsPath({ kind: "workspace", id: workspace.id })),
        showCredentials ? request<{ credentials: Credential[] }>(scopeCredentialsPath({ kind: "workspace", id: workspace.id })) : Promise.resolve(null),
      ]).then(([{ grants }, credentials]) => summarizeScopeAgents({ roles: workspaceAgentRoles, grants, credentials: credentials?.credentials ?? null, tasks: null, now })),
    workspaceNotFound,
  );
  return (
    <section className="detail-section" aria-labelledby="workspace-direction-agents-heading">
      <h2 id="workspace-direction-agents-heading">WorkspaceのDirection Role <span className={statusBadgeClass("muted")}>Workspace</span></h2>
      <p className="section-note">
        Intent・Outcome・Research・Evaluationを担うRoleで、Workspace Grantで割り当てます。ProjectのRoleからは継承しません。
        Direction RoleはTaskのClaimを持たないため、作業中かどうかはここでは観測できません。割当とWorkspace Credentialの発行は<Link to={workspacePath(workspace.id, "settings")}>Workspaceの設定</Link>で行います。
      </p>
      <Toolbar fetchedAt={loaded?.fetchedAt ?? null} pending={pending} onReload={() => void reload()} />
      {error ? <ErrorState message={`Agentの読み込みに失敗しました: ${error}`} /> : !loaded ? <Loading /> : (
        <>
          <h3>Role</h3>
          <RoleList roles={workspaceAgentRoles} principalIds={principalIdsByRole(loaded.agents)} />
          <h3>Agent</h3>
          <PrincipalList agents={loaded.agents} empty="このWorkspaceにDirection RoleのAgentは割り当てられていません。" credentialHint="Workspaceのadministrator以上が確認できます" />
        </>
      )}
    </section>
  );
};

/** 表示に使うProjectの項目（WorkspaceのProject一覧の1件）。 */
type AgentProject = { id: string; name: string };

/** Project 1件のExecution Role。Project Membershipで読み、Credentialはそのprojectのadministrator以上にだけ出す。 */
const ProjectAgents = ({ project }: { project: AgentProject }) => {
  const { loaded, error, pending, reload } = useScopeAgents(
    project.id,
    async (now) => {
      const [{ myRole }, { grants }, overview] = await Promise.all([
        request<{ myRole: HumanRole }>(`/api/projects/${project.id}`),
        request<{ grants: ScopeGrant[] }>(grantsPath(project.id)),
        request<ExecutionOverview>(executionPath(project.id)),
      ]);
      const credentials = canOperate(myRole, "credential.manage") ? (await request<{ credentials: Credential[] }>(credentialsPath(project.id))).credentials : null;
      return summarizeScopeAgents({ roles: projectAgentRoles, grants, credentials, tasks: overview.tasks, now });
    },
    "Projectが見つからないか、閲覧する権限がありません。",
  );
  const headingId = `project-agents-${project.id}`;
  return (
    <article className="agent-project" aria-labelledby={headingId}>
      <div className="agent-project-head">
        <h3 id={headingId}>{project.name}</h3>
        <Link to={projectViewPath(project.id, "settings", agentRoleAnchorId("worker"))} className="text-link">割当を管理 →</Link>
      </div>
      <Toolbar fetchedAt={loaded?.fetchedAt ?? null} pending={pending} onReload={() => void reload()} />
      {error ? <ErrorState message={`Agentの読み込みに失敗しました: ${error}`} /> : !loaded ? <Loading /> : (
        <>
          <p className="agent-project-roles">
            {loaded.agents.roles.map(({ role, principalIds }) => (
              <span key={role}><strong>{grantRoleLabels[role]}</strong> {principalIds.length ? principalIds.map((id) => <code key={id}>{id}</code>) : <span className="unset">未割当</span>}</span>
            ))}
          </p>
          <PrincipalList agents={loaded.agents} empty="このProjectにExecution RoleのAgentは割り当てられておらず、Claimを保持しているAgentもいません。" credentialHint="Projectのadministrator以上が確認できます" />
          {(loaded.agents.reclaimableCount ?? 0) > 0 && (
            <p className="claim-holder-reclaimable"><span className={statusBadgeClass("warning")}>再取得待ち</span> {loaded.agents.reclaimableCount}件 — Claimの期限が切れ、Workerの再取得待ちです（担当中ではありません）</p>
          )}
        </>
      )}
    </article>
  );
};

/**
 * ProjectのExecution Role（Manager・Worker・Reviewer）。Project GrantとTaskのClaimをProjectごとに出す。
 * Project詳細はProject Membershipで認可するため、Membershipの無いProjectは理由だけを出す。
 */
export const ProjectAgentsSection = ({ projects }: { projects: { project: AgentProject; canOpen: boolean }[] | null; }) => (
  <section className="detail-section" aria-labelledby="project-execution-agents-heading">
    <h2 id="project-execution-agents-heading">ProjectのExecution Role <span className={statusBadgeClass("muted")}>Project</span></h2>
    <p className="section-note">
      Story・Taskを担うRoleで、Projectごとに割り当てます（ManagerもProjectのRoleです）。Claimは作業・レビュー・受入の期限付きの保持で、Agentプロセスの稼働を示しません。
      activeなProjectだけを表示します。
    </p>
    <h3>Role</h3>
    <RoleList roles={projectAgentRoles} />
    {projects === null ? <Loading /> : projects.length === 0 ? <p className="unset">activeなProjectはありません。</p> : (
      <div className="agent-projects">
        {projects.map(({ project, canOpen }) => canOpen ? <ProjectAgents key={project.id} project={project} /> : (
          <article key={project.id} className="agent-project locked" aria-label={project.name}>
            <h3>{project.name}</h3>
            <p className="locked-note">Project Membershipが無いため、このProjectのAgent・Claimは表示できません。Projectのownerに招待を依頼してください。</p>
          </article>
        ))}
      </div>
    )}
  </section>
);
