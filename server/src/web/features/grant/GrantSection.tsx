import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { classifyError, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ErrorState, Loading } from "../../components/StateCard";
import { useHashTarget } from "../../useHashTarget";
import { credentialStatus, scopeCredentialsPath, type Credential } from "../credential";
import { GrantRow } from "./GrantRow";
import {
  agentRoleAnchorId,
  agentRoleDescriptions,
  canGrantInScope,
  grantInit,
  grantNotice,
  grantRoleLabels,
  scopeGrantRoles,
  scopeGrantsPath,
  scopeNotFoundMessage,
  type AgentRole,
  type Grant,
  type GrantResponse,
  type GrantScope,
} from "./grants";

// ---- Role Grant（Step 4でStrategist、Task 29でResearcher、Task 33でManager・Worker・Reviewerを統合、Task 03で1つの一覧へ）。Agentの稼働状況・Run・自動起動は扱わないため表示しない。 ----
// Project設定はExecution Role（旧Direction Grantは参照・取消だけ）、Workspace設定はDirection Roleを同じ部品で扱う。互いのGrantは継承しない。

const scopePath = (scope: GrantScope) => (scope.kind === "workspace" ? `/workspaces/${scope.id}` : `/projects/${scope.id}`);

/** Role 1つの割当フォーム。失敗しても入力（principalId）は維持し、そのまま再送信できる。 */
const GrantForm = ({ scope, role, onGranted }: { scope: GrantScope; role: AgentRole; onGranted: () => Promise<void> }) => {
  const label = grantRoleLabels[role];
  const [principalId, setPrincipalId] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      const { grant, created } = await request<GrantResponse>(scopeGrantsPath(scope), grantInit(principalId, role));
      setNotice(grantNotice(created, grant.principalId, role));
      setPrincipalId("");
      await onGranted();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), `${scopeNotFoundMessage(scope)}削除された可能性があります。`));
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <>
      {error && <FormErrorSummary error={error} detailTo={scopePath(scope)} conflict={{ title: `${label}に割り当てられませんでした` }} />}
      <form className="grant-form" onSubmit={submit}>
        <label>
          Agent名 <span>必須</span>
          <small>100文字まで。大文字小文字は区別されます。</small>
          <input {...fieldProps(invalid, "field-principalId")} required aria-required="true" maxLength={100} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
        </label>
        <div className="form-actions">
          <button className="button" disabled={isSubmitting}>{isSubmitting ? "割当中..." : `${label}に割り当てる`}</button>
        </div>
      </form>
      {notice && <p className="grant-notice" role="status">{notice}</p>}
    </>
  );
};

type RoleRowProps = { scope: GrantScope; role: AgentRole; grants: Grant[]; credentials: Credential[] | null; now: number; readOnly: boolean; reload: () => Promise<void> };

/** Role 1行。Role名・割当済みAgent・（administratorには）Credentialの有無を出し、割当・取消は行を展開したときだけ出す。 */
const RoleRow = ({ scope, role, grants, credentials, now, readOnly, reload }: RoleRowProps) => {
  const id = agentRoleAnchorId(role);
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === `#${id}`);
  useEffect(() => { if (hash === `#${id}`) setOpen(true); }, [hash, id]);
  const hasCredential = (principalId: string) => credentials?.some((item) => item.kind === "agent" && item.principalId === principalId && credentialStatus(item, now) === "active") ?? false;
  const grantable = canGrantInScope(scope, role);
  return (
    <li>
      <details id={id} tabIndex={-1} className="agent-role" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
        <summary>
          <span className="agent-role-name">{grantRoleLabels[role]}</span>
          <span className="agent-role-agents">
            {grants.length ? grants.map((grant) => (
              <span key={grant.principalId} className="agent-role-agent">
                <code>{grant.principalId}</code>
                {credentials && <span className={`status-badge${hasCredential(grant.principalId) ? " muted" : ""}`}>{hasCredential(grant.principalId) ? "Credentialあり" : "Credential無し"}</span>}
              </span>
            )) : <span className="unset">未割当</span>}
          </span>
        </summary>
        <p className="section-note">{agentRoleDescriptions[role]}{grantRoleLabels[role]}の割当はAgentを起動しません。</p>
        {grants.length > 0 && (
          <ul className="grant-list">
            {grants.map((grant) => <GrantRow key={grant.principalId} scope={scope} grant={grant} readOnly={readOnly} onRevoked={() => void reload()} />)}
          </ul>
        )}
        {!grantable && <p className="section-note">WorkspaceのRoleです。Projectからの新規割当はできません。</p>}
        {!readOnly && grantable && <GrantForm scope={scope} role={role} onGranted={reload} />}
      </details>
    </li>
  );
};

const sectionNotes: Record<GrantScope["kind"], string> = {
  project: "Roleごとに割り当てたAgentです。",
  workspace: "Intent・Outcome等のDirectionを担うRoleごとに割り当てたAgentです。このWorkspaceのDirectionだけに使え、所属ProjectのStory・Taskには使えません（ProjectのRoleは各Projectの設定で割り当てます）。",
};

/**
 * 「設定」のAgent（Role割当）を1つの一覧で出す。Projectは6種（旧Direction Grantは参照・取消だけ）、WorkspaceはDirection Roleの3種。
 * `readOnly`（archived・権限なし）では割当・取消の導線を出さない。`showCredentials`（Credentialを参照できるadministrator）にだけ、
 * 割当済みAgentの同じscopeのCredentialの有無を出す。
 */
export const AgentSettingsSection = ({ scope, readOnly, showCredentials }: { scope: GrantScope; readOnly: boolean; showCredentials: boolean }) => {
  const [loaded, setLoaded] = useState<{ grants: Grant[]; credentials: Credential[] | null; now: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        request<{ grants: Grant[] }>(scopeGrantsPath(scope)),
        showCredentials ? request<{ credentials: Credential[] }>(scopeCredentialsPath(scope)) : Promise.resolve(null),
      ])
        .then(([{ grants }, credentials]) => { setLoaded({ grants, credentials: credentials?.credentials ?? null, now: Date.now() }); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), scopeNotFoundMessage(scope)))),
    [scope.kind, scope.id, showCredentials],
  );
  useEffect(() => { void load(); }, [load]);
  useHashTarget(loaded !== null);
  return (
    <section className="detail-section" aria-labelledby="agent-settings-heading">
      <h2 id="agent-settings-heading">{scope.kind === "workspace" ? "Direction Agent" : "Agent"}</h2>
      <p className="section-note">
        {sectionNotes[scope.kind]}Agent名は、Agent Credentialを発行するときのAgent名です（trusted-local modeではMCPの <code>Authorization: Bearer &lt;AgentName&gt;</code> にも使えます）。
        割当・Credentialは、Agentが起動・接続していることを示しません。{!readOnly && "行を開くと割当・取消ができます。"}
      </p>
      {loadError ? <ErrorState message={`Agentの読み込みに失敗しました: ${loadError}`} /> : loaded === null ? <Loading /> : (
        <ul className="agent-role-list">
          {scopeGrantRoles(scope).map((role) => <RoleRow key={role} scope={scope} role={role} grants={loaded.grants.filter((grant) => grant.role === role)} credentials={loaded.credentials} now={loaded.now} readOnly={readOnly} reload={load} />)}
        </ul>
      )}
    </section>
  );
};
