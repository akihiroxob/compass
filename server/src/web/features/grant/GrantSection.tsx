import { useCallback, useEffect, useState, type FormEvent } from "react";
import { useLocation } from "react-router-dom";
import { classifyError, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ErrorState, Loading } from "../../components/StateCard";
import { useHashTarget } from "../../useHashTarget";
import { credentialStatus, credentialsPath, type Credential } from "../credential";
import { GrantRow } from "./GrantRow";
import { agentRoleAnchorId, agentRoles, grantInit, grantNotice, grantRoleLabels, grantsPath, type AgentRole, type Grant, type GrantResponse } from "./grants";

// ---- Project Role Grant（Step 4でStrategist、Task 29でResearcher、Task 33でManager・Worker・Reviewerを統合、Task 03で1つの一覧へ）。Agentの稼働状況・Run・自動起動は扱わないため表示しない。 ----

const roleDescriptions: Record<AgentRole, string> = {
  strategist: "Intentから次に達成すべきOutcomeを判断します。",
  researcher: "Research Requestの調査結果を登録します。",
  manager: "確定したOutcomeをStory・Taskへ落とし込み、最終受入します。",
  worker: "Taskを引き受けて実装します。",
  reviewer: "完了したTaskを実装・検証の観点でレビューします。",
  evaluator: "Outcomeの成功条件を、還流したExecution Evidenceで評価します。",
};

/** Role 1つの割当フォーム。失敗しても入力（principalId）は維持し、そのまま再送信できる。 */
const GrantForm = ({ projectId, role, onGranted }: { projectId: string; role: AgentRole; onGranted: () => Promise<void> }) => {
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
      const { grant, created } = await request<GrantResponse>(grantsPath(projectId), grantInit(principalId, role));
      setNotice(grantNotice(created, grant.principalId, role));
      setPrincipalId("");
      await onGranted();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), "Projectが見つかりません。削除された可能性があります。"));
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <>
      {error && <FormErrorSummary error={error} projectDetailTo={`/projects/${projectId}`} />}
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

type RoleRowProps = { projectId: string; role: AgentRole; grants: Grant[]; credentials: Credential[] | null; now: number; readOnly: boolean; reload: () => Promise<void> };

/** Role 1行。Role名・割当済みAgent・（administratorには）Credentialの有無を出し、割当・取消は行を展開したときだけ出す。 */
const RoleRow = ({ projectId, role, grants, credentials, now, readOnly, reload }: RoleRowProps) => {
  const id = agentRoleAnchorId(role);
  const { hash } = useLocation();
  const [open, setOpen] = useState(hash === `#${id}`);
  useEffect(() => { if (hash === `#${id}`) setOpen(true); }, [hash, id]);
  const hasCredential = (principalId: string) => credentials?.some((item) => item.kind === "agent" && item.principalId === principalId && credentialStatus(item, now) === "active") ?? false;
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
        <p className="section-note">{roleDescriptions[role]}{grantRoleLabels[role]}の割当はAgentを起動しません。</p>
        {grants.length > 0 && (
          <ul className="grant-list">
            {grants.map((grant) => <GrantRow key={grant.principalId} projectId={projectId} grant={grant} readOnly={readOnly} onRevoked={() => void reload()} />)}
          </ul>
        )}
        {!readOnly && <GrantForm projectId={projectId} role={role} onGranted={reload} />}
      </details>
    </li>
  );
};

/**
 * 「設定」viewのAgent（Role割当6種）を1つの一覧で出す。`readOnly`（archivedのProject・権限なし）では割当・取消の導線を出さない。
 * `showCredentials`（Credentialを参照できるadministrator）にだけ、割当済みAgentのCredentialの有無を出す。
 */
export const AgentSettingsSection = ({ projectId, readOnly, showCredentials }: { projectId: string; readOnly: boolean; showCredentials: boolean }) => {
  const [loaded, setLoaded] = useState<{ grants: Grant[]; credentials: Credential[] | null; now: number } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      Promise.all([
        request<{ grants: Grant[] }>(grantsPath(projectId)),
        showCredentials ? request<{ credentials: Credential[] }>(credentialsPath(projectId)) : Promise.resolve(null),
      ])
        .then(([{ grants }, credentials]) => { setLoaded({ grants, credentials: credentials?.credentials ?? null, now: Date.now() }); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。"))),
    [projectId, showCredentials],
  );
  useEffect(() => { void load(); }, [load]);
  useHashTarget(loaded !== null);
  return (
    <section className="detail-section" aria-labelledby="agent-settings-heading">
      <h2 id="agent-settings-heading">Agent</h2>
      <p className="section-note">
        Roleごとに割り当てたAgentです。Agent名は、Agent Credentialを発行するときのAgent名です（trusted-local modeではMCPの <code>Authorization: Bearer &lt;AgentName&gt;</code> にも使えます）。
        割当・Credentialは、Agentが起動・接続していることを示しません。{!readOnly && "行を開くと割当・取消ができます。"}
      </p>
      {loadError ? <ErrorState message={`Agentの読み込みに失敗しました: ${loadError}`} /> : loaded === null ? <Loading /> : (
        <ul className="agent-role-list">
          {agentRoles.map((role) => <RoleRow key={role} projectId={projectId} role={role} grants={loaded.grants.filter((grant) => grant.role === role)} credentials={loaded.credentials} now={loaded.now} readOnly={readOnly} reload={load} />)}
        </ul>
      )}
    </section>
  );
};
