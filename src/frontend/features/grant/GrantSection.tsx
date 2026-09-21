import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ErrorState, Loading } from "../../components/StateCard";
import { GrantRow } from "./GrantRow";
import { grantInit, grantNotice, grantsPath, type Grant, type GrantResponse } from "./grants";

// ---- Strategist Role Grant（Step 4）。Agentの稼働状況・Run・自動起動は扱わないため表示しない。 ----
/** `readOnly`（archivedのProject）では、割当・取消の導線を出さず、割当済みの一覧だけを表示する。 */
export const GrantSection = ({ projectId, readOnly = false }: { projectId: string; readOnly?: boolean }) => {
  const [grants, setGrants] = useState<Grant[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [principalId, setPrincipalId] = useState("");
  const [error, setError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);

  const load = useCallback(
    () =>
      request<{ grants: Grant[] }>(grantsPath(projectId))
        .then((body) => { setGrants(body.grants); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。"))),
    [projectId],
  );
  useEffect(() => { void load(); }, [load]);

  // 失敗しても入力（principalId）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      const { grant, created } = await request<GrantResponse>(grantsPath(projectId), grantInit(principalId));
      setNotice(grantNotice(created, grant.principalId));
      setPrincipalId("");
      await load();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), "Projectが見つかりません。削除された可能性があります。"));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="detail-section" aria-labelledby="grant-heading">
      <h2 id="grant-heading">Strategist</h2>
      <p className="section-note">Agent名はMCPの <code>Authorization: Bearer &lt;AgentName&gt;</code> に設定する名前です。Strategistの割当はAgentを起動しません。API・CLIでも同じ操作ができ、この画面は任意の入口です。</p>
      {loadError ? <ErrorState message={`Strategistの読み込みに失敗しました: ${loadError}`} /> : grants === null ? <Loading /> : grants.length ? (
        <ul className="grant-list">
          {grants.map((grant) => <GrantRow key={`${grant.role}:${grant.principalId}`} projectId={projectId} grant={grant} readOnly={readOnly} onRevoked={() => void load()} />)}
        </ul>
      ) : <p className="unset">Strategistは未割当です</p>}
      {error && !readOnly && <FormErrorSummary error={error} projectDetailTo={`/projects/${projectId}`} />}
      {!readOnly && <form className="grant-form" onSubmit={submit}>
        <label>
          Agent名 <span>必須</span>
          <small>100文字まで。大文字小文字は区別されます。</small>
          <input {...fieldProps(invalid, "field-principalId")} required aria-required="true" maxLength={100} value={principalId} onChange={(event) => setPrincipalId(event.target.value)} />
        </label>
        <div className="form-actions">
          <button className="button" disabled={isSubmitting}>{isSubmitting ? "割当中..." : "Strategistに割り当てる"}</button>
        </div>
      </form>}
      {notice && !readOnly && <p className="grant-notice" role="status">{notice}</p>}
    </section>
  );
};
