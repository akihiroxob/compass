import { useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, request } from "../../api";
import { StateCard } from "../../components/StateCard";
import { Button, Checkbox, Dialog, Field, Fieldset, Select, TextInput } from "../../components/ui";
import { grantInit, grantRoleLabels, scopeGrantsPath, type AgentRole, type GrantResponse } from "../grant";
import { projectAgentRoles, registrationIssues, workspaceAgentRoles } from "./agents";
import type { AgentProject } from "./useWorkspaceAgents";

type Target = { kind: "workspace" | "project"; id: string; name: string };
type TargetResult = { target: Target; ok: true; created: boolean } | { target: Target; ok: false; error: string };

type AgentRegisterDialogProps = {
  open: boolean;
  onClose: () => void;
  workspace: { id: string; name: string };
  /** 担当範囲に選べるactiveなProject。 */
  projects: readonly AgentProject[];
  /** 既存のAgentへRoleを追加する場合のAgent名（変更できない）。 */
  principalId?: string;
  /** 1件以上の割当を送信した後（一覧の再読込）。 */
  onChanged: () => void;
  /** すべての割当に成功したとき。 */
  onRegistered: (principalId: string) => void;
};

const isProjectRole = (role: AgentRole | "") => projectAgentRoles.some((candidate) => candidate === role);

/**
 * Agentの登録（Role割当＝Grantの付与）。Workspace RoleはこのWorkspace、Project Roleは選んだ1つ以上のProjectへ、既存のGrant APIで
 * 1件ずつ割り当てる。認可・Agent名の束縛はserverが検証し、一部が失敗した場合はscopeごとの結果を残す。Credentialの発行・Agentの起動はしない。
 */
export const AgentRegisterDialog = ({ open, onClose, workspace, projects, principalId: fixedPrincipalId, onChanged, onRegistered }: AgentRegisterDialogProps) => {
  const [principalId, setPrincipalId] = useState(fixedPrincipalId ?? "");
  const [role, setRole] = useState<AgentRole | "">("");
  const [projectIds, setProjectIds] = useState<string[]>([]);
  const [issues, setIssues] = useState<string[]>([]);
  const [results, setResults] = useState<TargetResult[] | null>(null);
  const [pending, setPending] = useState(false);
  const close = () => {
    setIssues([]);
    setResults(null);
    if (!fixedPrincipalId) setPrincipalId("");
    setRole("");
    setProjectIds([]);
    onClose();
  };
  const toggleProject = (id: string, checked: boolean) =>
    setProjectIds((current) => (checked ? [...current, id] : current.filter((item) => item !== id)));
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const found = registrationIssues({ principalId, role, projectIds });
    setIssues(found);
    setResults(null);
    if (found.length || role === "") return;
    const name = principalId.trim();
    const targets: Target[] = isProjectRole(role)
      ? projects.filter((project) => projectIds.includes(project.id)).map((project) => ({ kind: "project", ...project }))
      : [{ kind: "workspace", ...workspace }];
    setPending(true);
    const next: TargetResult[] = [];
    for (const target of targets) {
      try {
        const { created } = await request<GrantResponse>(scopeGrantsPath(target), grantInit(name, role));
        next.push({ target, ok: true, created });
      } catch (reason) {
        next.push({ target, ok: false, error: describeActionFailure(classifyError(reason), `${target.kind === "workspace" ? "Workspace" : "Project"}が見つかりません。`) });
      }
    }
    setPending(false);
    onChanged();
    if (next.every((result) => result.ok)) {
      close();
      onRegistered(name);
    } else setResults(next);
  };
  const projectRole = isProjectRole(role);
  return (
    <Dialog open={open} onClose={close} title={fixedPrincipalId ? `${fixedPrincipalId} にRoleを割り当てる` : "Agentを登録"}>
      <p className="section-note">
        登録はAgent名へRoleを割り当てる（Grantを付与する）操作です。Credentialの発行とAgentの起動はしません。Credentialは登録後にAgentの詳細から発行します。
      </p>
      {issues.length > 0 && (
        <StateCard tone="error" role="alert"><p className="error-title">入力内容を確認してください</p><ul>{issues.map((issue) => <li key={issue}>{issue}</li>)}</ul></StateCard>
      )}
      {results && (
        <StateCard tone="error" role="alert">
          <p className="error-title">一部の割当に失敗しました</p>
          <ul>
            {results.map((result) => (
              <li key={`${result.target.kind}/${result.target.id}`}>
                {result.target.kind === "workspace" ? "Workspace" : result.target.name}: {result.ok ? (result.created ? "割り当てました" : "既に割当済みです") : result.error}
              </li>
            ))}
          </ul>
          <p>成功した割当は保存されています。失敗したscopeは内容を確認して再度送信できます。</p>
        </StateCard>
      )}
      <form className="grant-form" onSubmit={submit} noValidate>
        {fixedPrincipalId ? (
          <dl className="agent-dialog-facts"><div><dt>Agent名</dt><dd><code>{fixedPrincipalId}</code></dd></div></dl>
        ) : (
          <Field label="Agent名" required description="100文字まで。大文字小文字は区別されます。Agent Credentialを発行するときも同じ名前を使います。">
            <TextInput required maxLength={100} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
          </Field>
        )}
        <Field label="Role" required>
          <Select value={role} onChange={(event) => { setRole(event.target.value as AgentRole | ""); setResults(null); }}>
            <option value="">選択してください</option>
            <optgroup label="Workspace Role（このWorkspaceのDirection）">
              {workspaceAgentRoles.map((item) => <option key={item} value={item}>{grantRoleLabels[item]}</option>)}
            </optgroup>
            <optgroup label="Project Role（ProjectのStory・Task）">
              {projectAgentRoles.map((item) => <option key={item} value={item}>{grantRoleLabels[item]}</option>)}
            </optgroup>
          </Select>
        </Field>
        {role === "" ? null : projectRole ? (
          <Fieldset legend="担当するProject" required="1つ以上必須">
            {projects.length === 0 ? <p className="unset">activeなProjectがありません。</p> : projects.map((project) => (
              <Checkbox key={project.id} checked={projectIds.includes(project.id)} onChange={(event) => toggleProject(project.id, event.target.checked)}>{project.name}</Checkbox>
            ))}
          </Fieldset>
        ) : (
          <dl className="agent-dialog-facts"><div><dt>担当範囲</dt><dd>Workspace · {workspace.name}</dd></div></dl>
        )}
        {projectRole && projectIds.length > 1 && (
          <p className="section-note">複数のProjectに割り当てたAgent名には、Agent Credentialを発行できません（Agent Credentialは1つのWorkspaceまたはProjectに束縛されます）。Credentialで接続する場合は、Projectごとに別のAgent名を登録してください。</p>
        )}
        <div className="form-actions">
          <Button type="submit" pending={pending}>{pending ? "登録中..." : fixedPrincipalId ? "割り当てる" : "登録"}</Button>
        </div>
      </form>
    </Dialog>
  );
};
