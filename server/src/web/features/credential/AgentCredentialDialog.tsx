import { useId, useState, type FormEvent } from "react";
import { classifyError, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { Button, Dialog, Field, Select } from "../../components/ui";
import { IssuedToken } from "./CredentialSection";
import { credentialExpiryOptions, defaultCredentialExpiryDays, issueCredentialInit, scopeCredentialsPath, type CredentialScope, type IssuedCredential } from "./credentials";

type AgentCredentialDialogProps = {
  open: boolean;
  onClose: () => void;
  /** 発行先のscopeと表示名。Agent Credentialはこのscopeに束縛される。 */
  scope: CredentialScope & { name: string };
  principalId: string;
  /** 発行に成功したとき（一覧の再読込）。tokenはDialogの中だけで表示する。 */
  onIssued: () => void;
};

/**
 * 1つのAgent（Principal）へ、指定scopeのAgent Credentialを発行する。認可・Principalのscopeへの束縛はserverが検証する。
 * 発行はAgentを起動しない。tokenは発行直後にこのDialogの中で一度だけ表示し、閉じると再表示できない。
 */
export const AgentCredentialDialog = ({ open, onClose, scope, principalId, onIssued }: AgentCredentialDialogProps) => {
  const [expiresInDays, setExpiresInDays] = useState(defaultCredentialExpiryDays);
  const [error, setError] = useState<FormError | null>(null);
  const [issued, setIssued] = useState<IssuedCredential | null>(null);
  const [pending, setPending] = useState(false);
  const formId = useId();
  const invalid = invalidFieldIds(error);
  const close = () => {
    setIssued(null);
    setError(null);
    onClose();
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      setIssued(await request<IssuedCredential>(scopeCredentialsPath(scope), issueCredentialInit("agent", principalId, [], expiresInDays)));
      onIssued();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), `${scope.kind === "workspace" ? "Workspace" : "Project"}が見つかりません。画面を再読み込みしてください。`));
    } finally {
      setPending(false);
    }
  };
  const scopeLabel = scope.kind === "workspace" ? "Workspace" : "Project";
  return (
    <Dialog open={open} onClose={close} title={`${principalId} のAgent Credentialを発行`}>
      {issued ? <IssuedToken issued={issued} /> : (
        <>
          {error && <FormErrorSummary formId={formId} error={error} archivedScope={scopeLabel} conflict={{ title: "Credentialを発行できませんでした" }} />}
          <form className="grant-form" onSubmit={submit}>
            <dl className="intent-facts">
              <dt>Agent名</dt><dd><code>{principalId}</code></dd>
              <dt>対象scope</dt><dd>{scopeLabel} · {scope.name}</dd>
            </dl>
            <p className="section-note">このscopeのRole割当（Grant）で認可され、このscopeだけで使えます。tokenは発行直後に一度だけ表示します。発行はAgentを起動しません。</p>
            <Field label="有効期限">
              <Select {...fieldProps(invalid, "field-expiresInDays", formId)} value={expiresInDays} onChange={(event) => setExpiresInDays(Number(event.target.value))}>
                {credentialExpiryOptions.map((option) => <option key={option.days} value={option.days}>{option.label}</option>)}
              </Select>
            </Field>
            <div className="form-actions">
              <Button type="submit" pending={pending}>{pending ? "発行中..." : "Credentialを発行"}</Button>
            </div>
          </form>
        </>
      )}
    </Dialog>
  );
};
