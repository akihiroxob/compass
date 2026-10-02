import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import {
  allRuntimeScopes,
  credentialExpiryOptions,
  credentialKindLabels,
  credentialStatus,
  credentialStatusLabels,
  credentialsPath,
  defaultCredentialExpiryDays,
  defaultRotationGraceHours,
  issueCredentialInit,
  revokeCredentialInit,
  rotateCredentialInit,
  rotateCredentialPath,
  rotationGraceOptions,
  runtimeScopeOptions,
  type Credential,
  type CredentialKind,
  type IssuedCredential,
  type RuntimeScope,
} from "./credentials";

const notFound = "Projectまたは対象のCredentialが見つかりません。画面を再読み込みしてください。";
const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString("ja-JP");

/** 発行・rotation直後だけtokenを表示する（serverはhashしか保存しないため、再表示できない）。 */
const IssuedToken = ({ issued, onDismiss }: { issued: IssuedCredential; onDismiss: () => void }) => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.token);
      setCopied("コピーしました。");
    } catch {
      setCopied("コピーできませんでした。tokenを選択してコピーしてください。");
    }
  };
  const { credential } = issued;
  return (
    <div className="invitation-link" role="status">
      <p className="error-title">{credential.principalId} の{credentialKindLabels[credential.kind]} Credentialを{issued.previous ? "rotation" : "発行"}しました</p>
      <p>このtokenは今だけ表示されます。Agent・Runtimeの設定（<code>Authorization: Bearer &lt;token&gt;</code>）へ安全な方法で渡してください。{issued.previous ? `旧Credentialは ${formatTime(issued.previous.expiresAt)} まで併用できます。` : ""}</p>
      <label>
        token
        <input readOnly autoFocus value={issued.token} onFocus={(event) => event.target.select()} />
      </label>
      <div className="form-actions">
        <button type="button" className="secondary-button" onClick={onDismiss}>閉じる</button>
        <button type="button" className="button" onClick={() => void copy()}>tokenをコピー</button>
      </div>
      {copied && <p className="grant-notice">{copied}</p>}
    </div>
  );
};

type CredentialRowProps = {
  projectId: string;
  credential: Credential;
  readOnly: boolean;
  onChanged: () => void;
  onRotated: (issued: IssuedCredential) => void;
};

/** Credential 1件。有効なものだけrotation・取消の導線を出す。取消はarchivedのProjectでも行える。 */
const CredentialRow = ({ projectId, credential, readOnly, onChanged, onRotated }: CredentialRowProps) => {
  const status = credentialStatus(credential, Date.now());
  const [rotating, setRotating] = useState(false);
  const [graceHours, setGraceHours] = useState(defaultRotationGraceHours);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatePending, setRotatePending] = useState(false);
  const revoke = useReasonAction(async () => {
    await request<{ credential: Credential }>(credentialsPath(projectId, credential.id), revokeCredentialInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, notFound));
  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    setRotateError(null);
    setRotatePending(true);
    try {
      onRotated(await request<IssuedCredential>(rotateCredentialPath(projectId, credential.id), rotateCredentialInit(graceHours)));
      setRotating(false);
    } catch (failure) {
      setRotateError(describeActionFailure(classifyError(failure), notFound));
    } finally {
      setRotatePending(false);
    }
  };
  const graceId = `credential-grace-${credential.id}`;
  return (
    <li>
      <div>
        <strong>{credential.principalId}</strong> <span className={`status-badge${status === "active" ? "" : " muted"}`}>{credentialStatusLabels[status]}</span>
        <small>{credentialKindLabels[credential.kind]}・<code>{credential.prefix}…</code>{credential.kind === "runtime" && <>・{credential.scopes.join(", ")}</>}</small>
        <small>{formatTime(credential.createdAt)} 発行・{formatTime(credential.revokedAt ?? credential.expiresAt)} {credential.revokedAt === null ? "まで有効" : "に取消"}・最終利用 {credential.lastUsedAt === null ? "なし" : formatTime(credential.lastUsedAt)}</small>
      </div>
      {status === "active" && (
        <div className="action-row">
          {!readOnly && <button type="button" className="secondary-button compact" aria-expanded={rotating} onClick={() => setRotating(true)}>rotation</button>}
          <button type="button" className="secondary-button compact danger" aria-expanded={revoke.confirming} onClick={revoke.open}>取り消す</button>
        </div>
      )}
      {rotating && !readOnly && (
        <form className="abandon-panel" onSubmit={rotate}>
          <h2>{credential.principalId} のCredentialをrotationしますか？</h2>
          <p>同じ種別・Principal・scopeの新しいtokenを発行します。旧tokenは選んだ期間の後に使えなくなります。</p>
          <label htmlFor={graceId}>旧Credentialの併用期間</label>
          <select id={graceId} value={graceHours} onChange={(event) => setGraceHours(Number(event.target.value))}>
            {rotationGraceOptions.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
          </select>
          {rotateError && <div className="state-card error" role="alert">{rotateError}</div>}
          <div className="form-actions">
            <button type="button" className="secondary-button" onClick={() => { setRotating(false); setRotateError(null); }}>やめる</button>
            <button className="button" disabled={rotatePending}>{rotatePending ? "発行中..." : "新しいtokenを発行"}</button>
          </div>
        </form>
      )}
      {revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${credential.principalId} のCredentialを取り消しますか？`}
          description="取り消したtokenは次の呼出しから使えなくなります。元に戻せません。必要なら新しいCredentialを発行してください。"
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};

/**
 * Agent・Runtime Credential（Task 37）。Administrator以上だけに表示する（一覧もAdministrator以上）。
 * `readOnly`（archivedのProject）では発行・rotationの導線を出さず、一覧と取消だけを表示する。
 */
export const CredentialSection = ({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) => {
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<CredentialKind>("agent");
  const [principalId, setPrincipalId] = useState("");
  const [scopes, setScopes] = useState<RuntimeScope[]>(allRuntimeScopes);
  const [expiresInDays, setExpiresInDays] = useState(defaultCredentialExpiryDays);
  const [error, setError] = useState<FormError | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);

  const load = useCallback(
    () =>
      request<{ credentials: Credential[] }>(credentialsPath(projectId))
        .then((body) => { setCredentials(body.credentials); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), notFound))),
    [projectId],
  );
  useEffect(() => { void load(); }, [load]);

  const toggleScope = (scope: RuntimeScope, checked: boolean) =>
    setScopes((current) => (checked ? [...current, scope] : current.filter((item) => item !== scope)));

  // 失敗しても入力は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssued(null);
    setIsSubmitting(true);
    try {
      setIssued(await request<IssuedCredential>(credentialsPath(projectId), issueCredentialInit(kind, principalId, scopes, expiresInDays)));
      setPrincipalId("");
      await load();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), notFound));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="detail-section" aria-labelledby="credential-heading">
      <h2 id="credential-heading">Agent・Runtime Credential</h2>
      <p className="section-note">
        MCP・Runtime向けAPIの <code>Authorization: Bearer &lt;token&gt;</code> に設定するtokenです。Agent CredentialはこのProjectのRole割当で、Runtime Credentialは選んだscopeで認可します。
        発行したCredentialはこのProjectだけで使え、同じAgent名を別Projectと共有できません。発行はAgentやRuntimeを起動しません。
      </p>
      {loadError ? <ErrorState message={`Credentialの読み込みに失敗しました: ${loadError}`} /> : credentials === null ? <Loading /> : credentials.length ? (
        <ul className="grant-list" aria-labelledby="credential-heading">
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              projectId={projectId}
              credential={credential}
              readOnly={readOnly}
              onChanged={() => void load()}
              onRotated={(result) => { setIssued(result); void load(); }}
            />
          ))}
        </ul>
      ) : <p className="unset">Credentialはありません</p>}
      {error && !readOnly && <FormErrorSummary error={error} projectDetailTo={`/projects/${projectId}`} conflict={{ title: "Credentialを発行できませんでした" }} />}
      {issued && <IssuedToken issued={issued} onDismiss={() => setIssued(null)} />}
      {!readOnly && (
        <form className="grant-form" onSubmit={submit}>
          <label>
            種別 <span>必須</span>
            <select {...fieldProps(invalid, "field-kind")} value={kind} onChange={(event) => setKind(event.target.value as CredentialKind)}>
              <option value="agent">Agent（Role割当で認可）</option>
              <option value="runtime">Runtime（scopeで認可）</option>
            </select>
          </label>
          <label>
            {kind === "agent" ? "Agent名" : "Runtime名（consumer）"} <span>必須</span>
            <small>100文字まで。大文字小文字は区別されます。{kind === "agent" ? "Role割当のAgent名と同じ名前にします。" : "ackはこの名前ごとに記録されます。"}</small>
            <input {...fieldProps(invalid, "field-principalId")} required aria-required="true" maxLength={100} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
          </label>
          {kind === "runtime" && (
            <fieldset className="repeat-field scope-field" {...fieldProps(invalid, "field-scopes")}>
              <legend>scope <span>1つ以上必須</span></legend>
              {runtimeScopeOptions.map((option) => (
                <label key={option.scope} className="checkbox-label">
                  <input type="checkbox" checked={scopes.includes(option.scope)} onChange={(event) => toggleScope(option.scope, event.target.checked)} />
                  {option.label} <code>{option.scope}</code>
                </label>
              ))}
            </fieldset>
          )}
          <label>
            有効期限
            <select {...fieldProps(invalid, "field-expiresInDays")} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
              {credentialExpiryOptions.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
            </select>
          </label>
          <div className="form-actions">
            <button className="button" disabled={isSubmitting}>{isSubmitting ? "発行中..." : "Credentialを発行"}</button>
          </div>
        </form>
      )}
    </section>
  );
};
