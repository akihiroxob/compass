import { useId, useState } from "react";
import { Link } from "react-router-dom";
import { Button, Field, Select, TextArea, TextInput } from "../../components/ui";
import { workspacePath } from "../../paths";
import { credentialSectionId } from "../credential";
import { grantRoleLabels, type AgentRole } from "../grant";
import { mcpConnectionCheck, mcpConnectionExample, mcpConnectionRoles, mcpConnectionUrl, type McpConnectionScope } from "./model";

/** 接続案内だけを提供する。Secretの入力・APIへの送信・永続化は行わない。 */
export const McpConnectionSection = ({ scope, workspaceId, canManageCredentials, origin = window.location.origin }: {
  scope: McpConnectionScope; workspaceId: string; canManageCredentials: boolean; origin?: string;
}) => {
  const headingId = useId();
  const roles = mcpConnectionRoles(scope.kind);
  const [selectedRole, setSelectedRole] = useState<AgentRole>(roles[0]!);
  const role = roles.find((candidate) => candidate === selectedRole) ?? roles[0]!;
  const [notice, setNotice] = useState<string | null>(null);
  const url = mcpConnectionUrl(origin);
  const example = mcpConnectionExample(origin, role);
  const scopeLabel = scope.kind === "workspace" ? "Workspace" : "Project";
  const copy = async (text: string, label: string) => {
    try { await navigator.clipboard.writeText(text); setNotice(`${label}をコピーしました。`); }
    catch { setNotice("コピーできませんでした。欄内を選択してコピーしてください。"); }
  };
  return <section className="detail-section" id="mcp-connection" aria-labelledby={headingId}>
    <h2 id={headingId}>MCP接続</h2>
    <p className="section-note">HTTPのBearerヘッダーを設定できるMCPクライアントから接続します。Googleログインとは別に、Agent Credentialを使います。</p>
    <div className="form-section">
      <Field label="接続URL"><TextInput readOnly value={url} onFocus={(event) => event.target.select()} /></Field>
      <div className="form-actions"><Button variant="secondary" onClick={() => void copy(url, "接続URL")}>URLをコピー</Button></div>
      <Field label={`${scopeLabel} ID`}><TextInput readOnly value={scope.id} onFocus={(event) => event.target.select()} /></Field>
    </div>
    <ol>
      <li><Link to={workspacePath(workspaceId, "agents")}>Agent管理</Link>で、この{scopeLabel}を担当するAgentにRoleを割り当てます。</li>
      <li>{canManageCredentials ? <><a href={`#${credentialSectionId}`}>Credential</a>で、同じAgent・{scopeLabel}のAgent Credentialを発行します。</> : <>Workspaceのadministrator以上のMemberに、同じAgent・{scopeLabel}のAgent Credentialの発行を依頼します。</>}</li>
      <li>クライアントに接続URLと以下のHTTPヘッダーを設定します。<code>&lt;AGENT_CREDENTIAL&gt;</code>は発行したtokenに置き換えてください。</li>
    </ol>
    <div className="form-section">
      <Field label="接続するRole"><Select value={role} onChange={(event) => { setSelectedRole(event.target.value as AgentRole); setNotice(null); }}>
        {roles.map((candidate) => <option key={candidate} value={candidate}>{grantRoleLabels[candidate]}</option>)}
      </Select></Field>
      <Field label="JSON設定例" description="設定形式はクライアントにより異なります。urlとheadersの値を使ってください。">
        <TextArea readOnly rows={12} value={example} onFocus={(event) => event.target.select()} spellCheck={false} />
      </Field>
      <div className="form-actions"><Button variant="secondary" onClick={() => void copy(example, "設定例")}>設定例をコピー</Button></div>
      {notice && <p role="status">{notice}</p>}
    </div>
    <p>選んだRoleのGrantが必要です。WorkspaceとProjectのCredentialは相互に使えません。tokenは共有Repositoryへ保存しないでください。</p>
    <details><summary>接続を確認する</summary><p>接続後、Agentに以下のToolと引数でRole Contextの取得を依頼してください。</p><pre className="pre-wrap"><code>{mcpConnectionCheck(scope, role)}</code></pre></details>
  </section>;
};
