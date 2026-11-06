import { useId, useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Field, Select, TextInput } from "../../components/ui";
import { statusBadgeClass } from "../../statusTone";
import {
  defaultInvitationExpiryHours,
  deleteInit,
  humanRoleDescriptions,
  humanRoleLabels,
  humanRoleOptions,
  invitationDisplayStatus,
  invitationExpiryOptions,
  invitationInit,
  invitationStatusLabels,
  invitationStatusTones,
  invitationsPath,
  type HumanRole,
  type Invitation,
  type InvitationResponse,
} from "./members";

const workspaceNotFound = "Workspaceまたは対象が見つかりません。画面を再読み込みしてください。";
const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString("ja-JP");

const InvitationRow = ({ workspaceId, invitation, manage, onChanged }: { workspaceId: string; invitation: Invitation; manage: boolean; onChanged: () => void }) => {
  const status = invitationDisplayStatus(invitation, Date.now());
  const revoke = useReasonAction(async () => {
    await request<{ invitation: Invitation }>(invitationsPath(workspaceId, invitation.id), deleteInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, workspaceNotFound));
  return (
    <li>
      <div>
        <strong>{invitation.email}</strong> <span className={statusBadgeClass(invitationStatusTones[status])}>{invitationStatusLabels[status]}</span>
        <small>{humanRoleLabels[invitation.role]}・{formatTime(invitation.createdAt)} 発行・{formatTime(invitation.expiresAt)} まで有効</small>
      </div>
      {manage && status === "pending" && (
        <Button variant="secondary" size="sm" tone="danger" aria-expanded={revoke.confirming} onClick={revoke.open}>招待を取り消す</Button>
      )}
      {manage && revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${invitation.email} への招待を取り消しますか？`}
          description="取り消した招待リンクでは参加できなくなります。必要なら新しい招待を発行してください。"
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};

/** 発行直後だけ招待リンクを表示する（serverはtokenを保存しないため、再表示できない）。 */
const IssuedInvitation = ({ issued, onDismiss }: { issued: InvitationResponse; onDismiss: () => void }) => {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(issued.invitationUrl);
      setCopied("コピーしました。");
    } catch {
      setCopied("コピーできませんでした。リンクを選択してコピーしてください。");
    }
  };
  return (
    <div className="invitation-link" role="status">
      <p className="error-title">{issued.invitation.email} への招待リンクを発行しました</p>
      <p>このリンクは今だけ表示されます。相手へ安全な方法で渡してください。招待されたメールアドレスのアカウントでログインしたときだけ参加できます。</p>
      <Field label="招待リンク">
        <TextInput readOnly autoFocus value={issued.invitationUrl} onFocus={(event) => event.target.select()} />
      </Field>
      <div className="form-actions">
        <Button variant="secondary" onClick={onDismiss}>閉じる</Button>
        <Button onClick={() => void copy()}>リンクをコピー</Button>
      </div>
      {copied && <p className="grant-notice">{copied}</p>}
    </div>
  );
};

/**
 * Workspaceのownerによる招待。参加すると配下の全Projectを同じRoleで利用できる。
 * archivedのWorkspaceでは一覧だけを表示する。
 */
export const WorkspaceInvitationSection = ({ workspaceId, readOnly }: { workspaceId: string; readOnly: boolean }) => {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HumanRole>("viewer");
  const [expiresInHours, setExpiresInHours] = useState(defaultInvitationExpiryHours);
  const [error, setError] = useState<FormError | null>(null);
  const [issued, setIssued] = useState<InvitationResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const formId = useId();
  const invalid = invalidFieldIds(error);

  const load = useCallback(
    () =>
      request<{ invitations: Invitation[] }>(invitationsPath(workspaceId))
        .then((body) => { setInvitations(body.invitations); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), workspaceNotFound))),
    [workspaceId],
  );
  useEffect(() => { void load(); }, [load]);

  // 失敗しても入力は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssued(null);
    setIsSubmitting(true);
    try {
      setIssued(await request<InvitationResponse>(invitationsPath(workspaceId), invitationInit(email, role, expiresInHours)));
      setEmail("");
      await load();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), workspaceNotFound));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <section className="detail-section" aria-labelledby="invitation-heading">
      <h2 id="invitation-heading">招待</h2>
      <p className="section-note">参加するとWorkspaceのMemberになり、配下のすべてのProjectを同じRoleで利用できます。招待はメールで送られません。発行したリンクを相手へ渡してください。受諾できるのは一度だけです。</p>
      {loadError ? <ErrorState message={`招待の読み込みに失敗しました: ${loadError}`} /> : invitations === null ? <Loading /> : invitations.length ? (
        <ul className="grant-list" aria-labelledby="invitation-heading">
          {invitations.map((invitation) => <InvitationRow key={invitation.id} workspaceId={workspaceId} invitation={invitation} manage={!readOnly} onChanged={() => void load()} />)}
        </ul>
      ) : <p className="unset">招待はありません</p>}
      {error && !readOnly && <FormErrorSummary formId={formId} error={error} detailTo={`/workspaces/${workspaceId}`} conflict={{ title: "招待を発行できませんでした" }} />}
      {issued && !readOnly && <IssuedInvitation issued={issued} onDismiss={() => setIssued(null)} />}
      {!readOnly && (
        <form className="grant-form" onSubmit={submit}>
          <Field label="メールアドレス" required description="招待する相手がログインに使うアカウントのメールアドレス。">
            <TextInput {...fieldProps(invalid, "field-email", formId)} type="email" required maxLength={320} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Role" required description="Workspaceと配下のすべてのProjectに適用されます。">
            <Select {...fieldProps(invalid, "field-role", formId)} value={role} onChange={(event) => setRole(event.target.value as HumanRole)}>
              {humanRoleOptions.map((option) => <option key={option} value={option}>{humanRoleLabels[option]}（{humanRoleDescriptions[option]}）</option>)}
            </Select>
          </Field>
          <Field label="有効期限">
            <Select {...fieldProps(invalid, "field-expiresInHours", formId)} value={expiresInHours} onChange={(event) => setExpiresInHours(Number(event.target.value))}>
              {invitationExpiryOptions.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
            </Select>
          </Field>
          <div className="form-actions">
            <Button type="submit" pending={isSubmitting}>{isSubmitting ? "発行中..." : "招待リンクを発行"}</Button>
          </div>
        </form>
      )}
    </section>
  );
};
