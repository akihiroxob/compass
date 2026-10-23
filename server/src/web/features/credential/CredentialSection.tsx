import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ConfirmPanel, ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Checkbox, Field, Fieldset, Select, TextInput } from "../../components/ui";
import { useHashTarget } from "../../useHashTarget";
import { statusBadgeClass } from "../../statusTone";
import {
  credentialExpiryOptions,
  credentialKindLabels,
  credentialStatus,
  credentialStatusLabels,
  credentialStatusTones,
  credentialSectionId,
  defaultCredentialExpiryDays,
  defaultRotationGraceHours,
  issueCredentialInit,
  revokeCredentialInit,
  rotateCredentialInit,
  rotateCredentialPath,
  rotationGraceOptions,
  runtimeScopeOptionsFor,
  scopeCredentialsPath,
  type Credential,
  type CredentialKind,
  type CredentialScope,
  type IssuedCredential,
  type RuntimeScope,
} from "./credentials";

const scopeLabel = (scope: CredentialScope) => (scope.kind === "workspace" ? "Workspace" : "Project");
const notFoundOf = (scope: CredentialScope) => `${scopeLabel(scope)}または対象のCredentialが見つかりません。画面を再読み込みしてください。`;
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
      <Field label="token">
        <TextInput readOnly autoFocus value={issued.token} onFocus={(event) => event.target.select()} />
      </Field>
      <div className="form-actions">
        <Button variant="secondary" onClick={onDismiss}>閉じる</Button>
        <Button onClick={() => void copy()}>tokenをコピー</Button>
      </div>
      {copied && <p className="grant-notice">{copied}</p>}
    </div>
  );
};

type CredentialRowProps = {
  scope: CredentialScope;
  credential: Credential;
  readOnly: boolean;
  onChanged: () => void;
  onRotated: (issued: IssuedCredential) => void;
};

/** Credential 1件。有効なものだけrotation・取消の導線を出す。取消はarchivedのscopeでも行える。 */
const CredentialRow = ({ scope, credential, readOnly, onChanged, onRotated }: CredentialRowProps) => {
  const notFound = notFoundOf(scope);
  const status = credentialStatus(credential, Date.now());
  const [rotating, setRotating] = useState(false);
  const [graceHours, setGraceHours] = useState(defaultRotationGraceHours);
  const [rotateError, setRotateError] = useState<string | null>(null);
  const [rotatePending, setRotatePending] = useState(false);
  const revoke = useReasonAction(async () => {
    await request<{ credential: Credential }>(scopeCredentialsPath(scope, credential.id), revokeCredentialInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, notFound));
  const rotate = async (event: FormEvent) => {
    event.preventDefault();
    setRotateError(null);
    setRotatePending(true);
    try {
      onRotated(await request<IssuedCredential>(rotateCredentialPath(scope, credential.id), rotateCredentialInit(graceHours)));
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
        <strong>{credential.principalId}</strong> <span className={statusBadgeClass(credentialStatusTones[status])}>{credentialStatusLabels[status]}</span>
        <small>{credentialKindLabels[credential.kind]}・<code>{credential.prefix}…</code>{credential.kind === "runtime" && <>・{credential.scopes.join(", ")}</>}</small>
        <small>{formatTime(credential.createdAt)} 発行・{formatTime(credential.revokedAt ?? credential.expiresAt)} {credential.revokedAt === null ? "まで有効" : "に取消"}・最終利用 {credential.lastUsedAt === null ? "なし" : formatTime(credential.lastUsedAt)}</small>
      </div>
      {status === "active" && (
        <div className="action-row">
          {!readOnly && <Button variant="secondary" size="sm" aria-expanded={rotating} onClick={() => setRotating(true)}>rotation</Button>}
          <Button variant="secondary" size="sm" tone="danger" aria-expanded={revoke.confirming} onClick={revoke.open}>取り消す</Button>
        </div>
      )}
      {rotating && !readOnly && (
        <ConfirmPanel
          title={`${credential.principalId} のCredentialをrotationしますか？`}
          description="同じ種別・Principal・scopeの新しいtokenを発行します。旧tokenは選んだ期間の後に使えなくなります。"
          error={rotateError}
          onSubmit={rotate}
          onCancel={() => { setRotating(false); setRotateError(null); }}
          submitLabel={rotatePending ? "発行中..." : "新しいtokenを発行"}
          pending={rotatePending}
        >
          <Field label="旧Credentialの併用期間">
            <Select id={graceId} value={graceHours} onChange={(event) => setGraceHours(Number(event.target.value))}>
              {rotationGraceOptions.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
            </Select>
          </Field>
        </ConfirmPanel>
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

const sectionNotes: Record<CredentialScope["kind"], string> = {
  project: "Agent CredentialはこのProjectのRole割当で、Runtime Credentialは選んだscopeで認可します。発行したCredentialはこのProjectだけで使え、所属WorkspaceのDirectionには使えません。同じAgent名を別のWorkspace・Projectと共有できません。",
  workspace: "Agent CredentialはこのWorkspaceのDirection Roleの割当で、Runtime Credentialは選んだscopeで認可します。発行したCredentialはこのWorkspaceだけで使え、所属ProjectのStory・Taskには使えません（ProjectのCredentialは各Projectの設定で発行します）。同じAgent名を別のWorkspace・Projectと共有できません。",
};

/**
 * Agent・Runtime Credential（Task 37）。scope（Workspace / Project）のAdministrator以上だけに表示する（一覧もAdministrator以上）。
 * `readOnly`（archivedのscope）では発行・rotationの導線を出さず、一覧と取消だけを表示する。
 */
export const CredentialSection = ({ scope, readOnly = false }: { scope: CredentialScope; readOnly?: boolean }) => {
  const notFound = notFoundOf(scope);
  const scopeOptions = runtimeScopeOptionsFor(scope.kind);
  const [credentials, setCredentials] = useState<Credential[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [kind, setKind] = useState<CredentialKind>("agent");
  const [principalId, setPrincipalId] = useState("");
  const [scopes, setScopes] = useState<RuntimeScope[]>(() => scopeOptions.map((option) => option.scope));
  const [expiresInDays, setExpiresInDays] = useState(defaultCredentialExpiryDays);
  const [error, setError] = useState<FormError | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);

  const load = useCallback(
    () =>
      request<{ credentials: Credential[] }>(scopeCredentialsPath(scope))
        .then((body) => { setCredentials(body.credentials); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), notFound))),
    [scope.kind, scope.id],
  );
  useEffect(() => { void load(); }, [load]);
  // 概要の「Credentialを発行」から`?view=settings#agent-credentials`で辿ったとき、一覧の読込後に移動する。
  useHashTarget(credentials !== null);

  const toggleScope = (scope: RuntimeScope, checked: boolean) =>
    setScopes((current) => (checked ? [...current, scope] : current.filter((item) => item !== scope)));

  // 失敗しても入力は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssued(null);
    setIsSubmitting(true);
    try {
      setIssued(await request<IssuedCredential>(scopeCredentialsPath(scope), issueCredentialInit(kind, principalId, scopes, expiresInDays)));
      setPrincipalId("");
      await load();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), notFound));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section id={credentialSectionId} tabIndex={-1} className="detail-section" aria-labelledby="credential-heading">
      <h2 id="credential-heading">Agent・Runtime Credential</h2>
      <p className="section-note">
        MCP・Runtime向けAPIの <code>Authorization: Bearer &lt;token&gt;</code> に設定するtokenです。{sectionNotes[scope.kind]}
        tokenは発行・rotationの直後に一度だけ表示し、一覧には表示しません。発行はAgentやRuntimeを起動しません。
      </p>
      {loadError ? <ErrorState message={`Credentialの読み込みに失敗しました: ${loadError}`} /> : credentials === null ? <Loading /> : credentials.length ? (
        <ul className="grant-list" aria-labelledby="credential-heading">
          {credentials.map((credential) => (
            <CredentialRow
              key={credential.id}
              scope={scope}
              credential={credential}
              readOnly={readOnly}
              onChanged={() => void load()}
              onRotated={(result) => { setIssued(result); void load(); }}
            />
          ))}
        </ul>
      ) : <p className="unset">Credentialはありません</p>}
      {error && !readOnly && <FormErrorSummary error={error} detailTo={`/${scope.kind === "workspace" ? "workspaces" : "projects"}/${scope.id}`} archivedScope={scopeLabel(scope)} conflict={{ title: "Credentialを発行できませんでした" }} />}
      {issued && <IssuedToken issued={issued} onDismiss={() => setIssued(null)} />}
      {!readOnly && (
        <form className="grant-form" onSubmit={submit}>
          <Field label="種別" required>
            <Select {...fieldProps(invalid, "field-kind")} value={kind} onChange={(event) => setKind(event.target.value as CredentialKind)}>
              <option value="agent">Agent（Role割当で認可）</option>
              <option value="runtime">Runtime（scopeで認可）</option>
            </Select>
          </Field>
          <Field label={kind === "agent" ? "Agent名" : "Runtime名（consumer）"} required description={`100文字まで。大文字小文字は区別されます。${kind === "agent" ? "Role割当のAgent名と同じ名前にします。" : "ackはこの名前ごとに記録されます。"}`}>
            <TextInput {...fieldProps(invalid, "field-principalId")} required maxLength={100} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
          </Field>
          {kind === "runtime" && (
            <Fieldset legend="scope" required="1つ以上必須" {...fieldProps(invalid, "field-scopes")}>
              {scopeOptions.map((option) => (
                <Checkbox key={option.scope} checked={scopes.includes(option.scope)} onChange={(event) => toggleScope(option.scope, event.target.checked)}>
                  {option.label} <code>{option.scope}</code>
                </Checkbox>
              ))}
            </Fieldset>
          )}
          <Field label="有効期限">
            <Select {...fieldProps(invalid, "field-expiresInDays")} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
              {credentialExpiryOptions.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
            </Select>
          </Field>
          <div className="form-actions">
            <Button type="submit" pending={isSubmitting}>{isSubmitting ? "発行中..." : "Credentialを発行"}</Button>
          </div>
        </form>
      )}
    </section>
  );
};
