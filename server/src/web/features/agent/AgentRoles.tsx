import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { statusBadgeClass } from "../../statusTone";
import { agentRoleDescriptions, grantRoleLabels, type AgentRole } from "../grant";
import { agentRolePath, projectAgentRoles, workspaceAgentRoles, type AgentRoleDefinition } from "./agents";

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
            {definition.source.revision ? <> · デプロイ版 <code>{definition.source.revision.slice(0, 12)}</code></> : " · デプロイ版は未設定"}
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

/** Roleの責務とRole定義への導線。 */
const RoleList = ({ roles }: { roles: readonly AgentRole[] }) => (
  <ul className="agent-role-cards">
    {roles.map((role) => (
      <li key={role}>
        <div className="agent-role-card-head"><strong>{grantRoleLabels[role]}</strong><span>{agentRoleDescriptions[role]}</span></div>
        <RoleDefinitionDetails role={role} />
      </li>
    ))}
  </ul>
);

/**
 * Roleの責務とRole定義・Skill。WorkspaceのDirection RoleとProjectのExecution Roleを分けて出す。割当（Grant）は各Agentの詳細で扱う。
 */
export const AgentRoleSection = () => (
  <section className="detail-section" aria-labelledby="agent-roles-heading">
    <h2 id="agent-roles-heading">Roleの責務と定義</h2>
    <p className="section-note">Skillは手順で、権限はGrant（Roleの割当）で決まります。Workspace RoleとProject Roleは互いに継承しません。</p>
    <h3>Workspace Role <span className={statusBadgeClass("muted")}>Workspace</span></h3>
    <RoleList roles={workspaceAgentRoles} />
    <h3>Project Role <span className={statusBadgeClass("muted")}>Project</span></h3>
    <RoleList roles={projectAgentRoles} />
  </section>
);
