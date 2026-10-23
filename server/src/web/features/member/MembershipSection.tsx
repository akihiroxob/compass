import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, Select, TextInput } from "../../components/ui";
import { statusBadgeClass } from "../../statusTone";
import {
  changeRoleInit,
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
  isLastOwner,
  memberScopeLabels,
  scopeMembersPath,
  scopeRoleDescriptions,
  type HumanRole,
  type Invitation,
  type InvitationResponse,
  type Member,
  type MemberScope,
  type Membership,
} from "./members";

const notFoundOf = (scope: MemberScope) => `${memberScopeLabels[scope.kind]}または対象が見つかりません。画面を再読み込みしてください。`;
const projectNotFound = notFoundOf({ kind: "project", id: "" });
const formatTime = (epochMs: number) => new Date(epochMs).toLocaleString("ja-JP");

type MemberRowProps = { scope: MemberScope; member: Member; members: Member[]; isSelf: boolean; manage: boolean; onChanged: () => void };

const revokeDescriptions: Record<MemberScope["kind"], (isSelf: boolean) => string> = {
  project: (isSelf) => `${isSelf ? "あなた自身は" : "このHumanは"}次の操作からこのProjectを参照・変更できなくなります。作成済みの内容は変更されません。再び参加するには新しい招待が必要です。`,
  workspace: (isSelf) => `${isSelf ? "あなた自身は" : "このHumanは"}次の操作からこのWorkspaceを参照・変更できなくなります。所属ProjectのMembershipとWorkの権限は変わりません。再び参加するにはWorkspaceのownerが追加し直します。`,
};

/**
 * Member 1件（Project / Workspace）。ownerだけRole変更・取消の導線を出す。最後のownerは導線を無効にする
 * （serverも`409 LAST_OWNER`で拒否する）。
 */
export const MemberRow = ({ scope, member, members, isSelf, manage, onChanged }: MemberRowProps) => {
  const notFound = notFoundOf(scope);
  const descriptions = scopeRoleDescriptions(scope);
  const { membership, human } = member;
  const [role, setRole] = useState<HumanRole>(membership.role);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lastOwner = isLastOwner(members, member);
  useEffect(() => setRole(membership.role), [membership.role]);
  const revoke = useReasonAction(async () => {
    await request<{ membership: Membership }>(scopeMembersPath(scope, membership.id), deleteInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, notFound));
  // 失敗しても選択したRoleは維持し、そのまま再送信できる。
  const changeRole = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await request<{ membership: Membership }>(scopeMembersPath(scope, membership.id), changeRoleInit(role));
      onChanged();
    } catch (failure) {
      setError(describeActionFailure(classifyError(failure), notFound));
    } finally {
      setPending(false);
    }
  };
  const selectId = `member-role-${membership.id}`;
  return (
    <li>
      <div>
        <strong>{human.displayName}</strong>{isSelf && <> <span className="status-badge muted">あなた</span></>}
        <small>{human.email}</small>
        <small>{humanRoleLabels[membership.role]}（{descriptions[membership.role]}）</small>
      </div>
      {manage && (
        <form className="member-role-form" onSubmit={changeRole}>
          <Field label={`${human.displayName}のRole`} labelHidden>
            <Select id={selectId} size="sm" value={role} disabled={lastOwner} onChange={(event) => setRole(event.target.value as HumanRole)}>
              {humanRoleOptions.map((option) => <option key={option} value={option}>{humanRoleLabels[option]}</option>)}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" size="sm" pending={pending} disabled={lastOwner || role === membership.role}>{pending ? "変更中..." : "Roleを変更"}</Button>
          <Button variant="secondary" size="sm" tone="danger" disabled={lastOwner} aria-expanded={revoke.confirming} onClick={revoke.open}>取り消す</Button>
        </form>
      )}
      {manage && lastOwner && <p className="section-note member-note">{memberScopeLabels[scope.kind]}の最後のownerのため、Role変更と取消はできません。</p>}
      {error && <div className="member-note"><StateCard tone="error" role="alert">{error}</StateCard></div>}
      {manage && revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${human.displayName} のMembershipを取り消しますか？`}
          description={revokeDescriptions[scope.kind](isSelf)}
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};

const InvitationRow = ({ projectId, invitation, manage, onChanged }: { projectId: string; invitation: Invitation; manage: boolean; onChanged: () => void }) => {
  const status = invitationDisplayStatus(invitation, Date.now());
  const revoke = useReasonAction(async () => {
    await request<{ invitation: Invitation }>(invitationsPath(projectId, invitation.id), deleteInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, projectNotFound));
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
          description="取り消した招待リンクではProjectに参加できなくなります。必要なら新しい招待を発行してください。"
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

const InvitationSection = ({ projectId, readOnly }: { projectId: string; readOnly: boolean }) => {
  const [invitations, setInvitations] = useState<Invitation[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<HumanRole>("viewer");
  const [expiresInHours, setExpiresInHours] = useState(defaultInvitationExpiryHours);
  const [error, setError] = useState<FormError | null>(null);
  const [issued, setIssued] = useState<InvitationResponse | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);

  const load = useCallback(
    () =>
      request<{ invitations: Invitation[] }>(invitationsPath(projectId))
        .then((body) => { setInvitations(body.invitations); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), projectNotFound))),
    [projectId],
  );
  useEffect(() => { void load(); }, [load]);

  // 失敗しても入力は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIssued(null);
    setIsSubmitting(true);
    try {
      setIssued(await request<InvitationResponse>(invitationsPath(projectId), invitationInit(email, role, expiresInHours)));
      setEmail("");
      await load();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), projectNotFound));
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <>
      <h3 id="invitation-heading">招待</h3>
      <p className="section-note">招待はメールで送られません。発行したリンクを相手へ渡してください。受諾できるのは一度だけです。</p>
      {loadError ? <ErrorState message={`招待の読み込みに失敗しました: ${loadError}`} /> : invitations === null ? <Loading /> : invitations.length ? (
        <ul className="grant-list" aria-labelledby="invitation-heading">
          {invitations.map((invitation) => <InvitationRow key={invitation.id} projectId={projectId} invitation={invitation} manage={!readOnly} onChanged={() => void load()} />)}
        </ul>
      ) : <p className="unset">招待はありません</p>}
      {error && !readOnly && <FormErrorSummary error={error} detailTo={`/projects/${projectId}`} conflict={{ title: "招待を発行できませんでした" }} />}
      {issued && !readOnly && <IssuedInvitation issued={issued} onDismiss={() => setIssued(null)} />}
      {!readOnly && (
        <form className="grant-form" onSubmit={submit}>
          <Field label="メールアドレス" required description="招待する相手がログインに使うアカウントのメールアドレス。">
            <TextInput {...fieldProps(invalid, "field-email")} type="email" required maxLength={320} autoComplete="off" value={email} onChange={(event) => setEmail(event.target.value)} />
          </Field>
          <Field label="Role" required>
            <Select {...fieldProps(invalid, "field-role")} value={role} onChange={(event) => setRole(event.target.value as HumanRole)}>
              {humanRoleOptions.map((option) => <option key={option} value={option}>{humanRoleLabels[option]}（{humanRoleDescriptions[option]}）</option>)}
            </Select>
          </Field>
          <Field label="有効期限">
            <Select {...fieldProps(invalid, "field-expiresInHours")} value={expiresInHours} onChange={(event) => setExpiresInHours(Number(event.target.value))}>
              {invitationExpiryOptions.map((option) => <option key={option.hours} value={option.hours}>{option.label}</option>)}
            </Select>
          </Field>
          <div className="form-actions">
            <Button type="submit" pending={isSubmitting}>{isSubmitting ? "発行中..." : "招待リンクを発行"}</Button>
          </div>
        </form>
      )}
    </>
  );
};

/**
 * Project Membership（docs/step-6-human-auth-design.md）。一覧はviewer以上、招待・Role変更・取消はownerだけに出す。
 * `readOnly`（archivedのProject）では一覧だけを表示する。自分のRole変更・取消の後は`onSelfChanged`で
 * Project（`myRole`）を読み直し、導線を新しいRoleへ揃える。
 */
export const MembershipSection = ({
  projectId,
  currentHumanId,
  manage,
  readOnly = false,
  onSelfChanged,
}: {
  projectId: string;
  currentHumanId: string | null;
  manage: boolean;
  readOnly?: boolean;
  onSelfChanged: () => void;
}) => {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      request<{ members: Member[] }>(scopeMembersPath({ kind: "project", id: projectId }))
        .then((body) => { setMembers(body.members); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), projectNotFound))),
    [projectId],
  );
  useEffect(() => { void load(); }, [load]);
  const editable = manage && !readOnly;
  return (
    <section className="detail-section" aria-labelledby="member-heading">
      <h2 id="member-heading">Member</h2>
      <p className="section-note">このProjectを利用できるHumanです。{manage ? "Role変更・取消は次の操作から反映されます。" : "Memberの招待・Role変更はProjectのownerが行います。"}</p>
      {loadError ? <ErrorState message={`Memberの読み込みに失敗しました: ${loadError}`} /> : members === null ? <Loading /> : (
        <ul className="grant-list" aria-labelledby="member-heading">
          {members.map((member) => <MemberRow key={member.membership.id} scope={{ kind: "project", id: projectId }} member={member} members={members} isSelf={member.human.id === currentHumanId} manage={editable} onChanged={() => (member.human.id === currentHumanId ? onSelfChanged() : void load())} />)}
        </ul>
      )}
      {manage && <InvitationSection projectId={projectId} readOnly={readOnly} />}
    </section>
  );
};
