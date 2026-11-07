import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, describeActionFailure, loadFailureMessage, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, Select, TextInput } from "../../components/ui";
import {
  changeRoleInit,
  deleteInit,
  filterMembers,
  humanRoleLabels,
  humanRoleOptions,
  isLastOwner,
  paginateMembers,
  workspaceMembersPath,
  type HumanRole,
  type Member,
  type Membership,
} from "./members";

const notFound = "Workspaceまたは対象が見つかりません。画面を再読み込みしてください。";

type MemberRowProps = { workspaceId: string; member: Member; members: Member[]; isSelf: boolean; manage: boolean; onChanged: () => void };

/**
 * Member 1件。ownerだけRole変更・除外の導線を出す。最後のownerは導線を無効にする（serverも`409 LAST_OWNER`で拒否する）。
 * 変更・除外はWorkspaceと配下のすべてのProjectへの次の操作から反映される。
 */
const MemberRow = ({ workspaceId, member, members, isSelf, manage, onChanged }: MemberRowProps) => {
  const { membership, human } = member;
  const [role, setRole] = useState<HumanRole>(membership.role);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const lastOwner = isLastOwner(members, member);
  useEffect(() => setRole(membership.role), [membership.role]);
  const revoke = useReasonAction(async () => {
    await request<{ membership: Membership }>(workspaceMembersPath(workspaceId, membership.id), deleteInit);
    onChanged();
  }, (classified) => describeActionFailure(classified, notFound));
  // 失敗しても選択したRoleは維持し、そのまま再送信できる。
  const changeRole = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setPending(true);
    try {
      await request<{ membership: Membership }>(workspaceMembersPath(workspaceId, membership.id), changeRoleInit(role));
      onChanged();
    } catch (failure) {
      setError(describeActionFailure(classifyError(failure), notFound));
    } finally {
      setPending(false);
    }
  };
  return (
    <li>
      <div>
        <strong>{human.displayName}</strong>{isSelf && <> <span className="status-badge muted">あなた</span></>}
        <small>{human.email}</small>
        <small>Role: {humanRoleLabels[membership.role]}</small>
      </div>
      {manage && (
        <form className="member-role-form" onSubmit={changeRole}>
          <Field label={`${human.displayName}のRole`} labelHidden>
            <Select id={`member-role-${membership.id}`} size="sm" value={role} disabled={lastOwner} onChange={(event) => setRole(event.target.value as HumanRole)}>
              {humanRoleOptions.map((option) => <option key={option} value={option}>{humanRoleLabels[option]}</option>)}
            </Select>
          </Field>
          <Button type="submit" variant="secondary" size="sm" pending={pending} disabled={lastOwner || role === membership.role}>{pending ? "変更中..." : "Roleを変更"}</Button>
          <Button variant="secondary" size="sm" tone="danger" disabled={lastOwner} aria-expanded={revoke.confirming} onClick={revoke.open}>除外</Button>
        </form>
      )}
      {manage && lastOwner && <p className="section-note member-note">Workspaceの最後のOwnerのため、Role変更と除外はできません。別のMemberをOwnerにしてから変更してください。</p>}
      {error && <div className="member-note"><StateCard tone="error" role="alert">{error}</StateCard></div>}
      {manage && revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${human.displayName} をWorkspaceから除外しますか？`}
          description={`${isSelf ? "あなた自身は" : "このHumanは"}次の操作からこのWorkspaceと配下のすべてのProjectを参照・変更できなくなります。作成済みの内容は変更されません。再び参加するには新しい招待が必要です。`}
          confirmLabel="除外する"
          pendingLabel="除外中..."
        />
      )}
    </li>
  );
};

/**
 * Workspace Membership（ADR 0003）。Humanの所属とRoleの唯一の管理単位で、配下のすべてのProjectに同じRoleを適用する。
 * 一覧はviewer以上、Role変更・除外はownerだけに出す。`readOnly`（archivedのWorkspace）では一覧だけを表示する。
 * 自分のRole変更・除外の後は`onSelfChanged`でWorkspace（`myRole`）を読み直し、導線を新しいRoleへ揃える。
 */
export const WorkspaceMembershipSection = ({
  workspaceId,
  currentHumanId,
  manage,
  readOnly = false,
  onSelfChanged,
}: {
  workspaceId: string;
  currentHumanId: string | null;
  manage: boolean;
  readOnly?: boolean;
  onSelfChanged: () => void;
}) => {
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const load = useCallback(
    () =>
      request<{ members: Member[] }>(workspaceMembersPath(workspaceId))
        .then((body) => { setMembers(body.members); setLoadError(null); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), notFound))),
    [workspaceId],
  );
  useEffect(() => { void load(); }, [load]);
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(1);
  const editable = manage && !readOnly;
  const matched = members ? filterMembers(members, query) : [];
  const view = paginateMembers(matched, page);
  const reason = readOnly
    ? "アーカイブ済みのWorkspaceのため、Memberは変更できません。"
    : manage ? null : "Role変更・除外・招待はWorkspaceのOwnerだけが行えます。";
  return (
    <section className="detail-section" aria-labelledby="workspace-member-heading">
      <h2 id="workspace-member-heading">参加者</h2>
      {reason && <p className="section-note" role="note">{reason}</p>}
      {loadError ? (
        <>
          <ErrorState message={`Memberの読み込みに失敗しました: ${loadError}`} />
          <Button variant="secondary" onClick={() => { setLoadError(null); void load(); }}>再読み込み</Button>
        </>
      ) : members === null ? <Loading /> : members.length === 0 ? (
        <StateCard role="status">Memberが見つかりません。取得結果が空のため、Workspaceのownerに確認してください。</StateCard>
      ) : (
        <>
          <div className="member-toolbar">
            <Field label="Memberを検索" layout="inline">
              <TextInput type="search" size="sm" value={query} placeholder="名前またはメールアドレス" onChange={(event) => { setQuery(event.target.value); setPage(1); }} />
            </Field>
            <span aria-live="polite">{query.trim() ? `一致 ${view.total}件 / 全${members.length}件` : `全${members.length}件`}</span>
          </div>
          {view.total === 0 ? (
            <StateCard role="status">「{query.trim()}」に一致するMemberはいません。<Button variant="text" onClick={() => { setQuery(""); setPage(1); }}>検索を解除</Button></StateCard>
          ) : (
            <ul className="grant-list" aria-labelledby="workspace-member-heading">
              {view.items.map((member) => <MemberRow key={member.membership.id} workspaceId={workspaceId} member={member} members={members} isSelf={member.human.id === currentHumanId} manage={editable} onChanged={() => (member.human.id === currentHumanId ? onSelfChanged() : void load())} />)}
            </ul>
          )}
          {view.pageCount > 1 && (
            <nav className="member-pager" aria-label="Memberのページ">
              <Button variant="secondary" size="sm" disabled={view.page <= 1} onClick={() => setPage(view.page - 1)}>前のページ</Button>
              <span aria-live="polite">{view.page} / {view.pageCount} ページ（{view.from}〜{view.to}件目）</span>
              <Button variant="secondary" size="sm" disabled={view.page >= view.pageCount} onClick={() => setPage(view.page + 1)}>次のページ</Button>
            </nav>
          )}
        </>
      )}
    </section>
  );
};
