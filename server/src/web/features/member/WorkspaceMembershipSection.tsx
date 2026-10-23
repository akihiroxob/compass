import { useCallback, useEffect, useState, type FormEvent } from "react";
import { classifyError, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Field, Select } from "../../components/ui";
import { MemberRow } from "./MembershipSection";
import {
  addWorkspaceMemberInit,
  humanRoleLabels,
  humanRoleOptions,
  scopeMembersPath,
  workspaceHumanRoleDescriptions,
  workspaceMemberCandidatesPath,
  type HumanRole,
  type Member,
  type MemberCandidate,
  type MemberScope,
  type Membership,
} from "./members";

const notFound = "Workspaceまたは対象が見つかりません。画面を再読み込みしてください。";

/**
 * Workspace memberの追加（owner）。候補は所属ProjectのMemberで、このWorkspaceのMemberでない者だけ（serverが返す）。
 * emailでのHuman検索は無い。失敗しても選択は維持し、そのまま再送信できる。
 */
const AddMemberForm = ({ workspaceId, membersRevision, onAdded }: { workspaceId: string; membersRevision: number; onAdded: () => Promise<void> }) => {
  const [candidates, setCandidates] = useState<MemberCandidate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [humanUserId, setHumanUserId] = useState("");
  const [role, setRole] = useState<HumanRole>("viewer");
  const [error, setError] = useState<FormError | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  const load = useCallback(
    () =>
      request<{ candidates: MemberCandidate[] }>(workspaceMemberCandidatesPath(workspaceId))
        .then((body) => {
          setCandidates(body.candidates);
          setLoadError(null);
          // 追加済み等で候補から外れた選択は解除する。
          setHumanUserId((current) => (body.candidates.some(({ id }) => id === current) ? current : ""));
        })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), notFound))),
    [workspaceId],
  );
  // Memberの一覧が変わる（追加・取消）たびに候補を読み直す。
  useEffect(() => { void load(); }, [load, membersRevision]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setNotice(null);
    setIsSubmitting(true);
    try {
      await request<{ membership: Membership }>(scopeMembersPath({ kind: "workspace", id: workspaceId }), addWorkspaceMemberInit(humanUserId, role));
      const added = candidates?.find(({ id }) => id === humanUserId);
      setNotice(`${added?.displayName ?? "Human"} を${humanRoleLabels[role]}としてWorkspaceに追加しました。`);
      setHumanUserId("");
      await onAdded();
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), "対象のHumanが所属ProjectのMemberではなくなったか、Workspaceが見つかりません。候補を読み込み直してください。"));
      void load();
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <>
      <h3 id="workspace-member-add-heading">Memberを追加</h3>
      <p className="section-note">追加できるのは、このWorkspaceに所属するProjectのMemberだけです。Workspaceに参加していない人は、先にProjectの設定から招待してください。追加はProjectのMembershipとRoleを変えません。</p>
      {loadError ? <ErrorState message={`追加できるHumanの読み込みに失敗しました: ${loadError}`} /> : candidates === null ? <Loading /> : candidates.length === 0 ? (
        <p className="unset">追加できるHumanはいません。所属ProjectのMemberのうち、まだこのWorkspaceのMemberでない人がいません。</p>
      ) : (
        <>
          {error && <FormErrorSummary error={error} detailTo={`/workspaces/${workspaceId}`} archivedScope="Workspace" conflict={{ title: "Memberを追加できませんでした" }} />}
          <form className="grant-form" onSubmit={submit} aria-labelledby="workspace-member-add-heading">
            <Field label="Human" required>
              <Select {...fieldProps(invalid, "field-humanUserId")} required value={humanUserId} onChange={(event) => setHumanUserId(event.target.value)}>
                <option value="">選択してください</option>
                {candidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName}（{candidate.email}）</option>)}
              </Select>
            </Field>
            <Field label="Role" required>
              <Select {...fieldProps(invalid, "field-role")} value={role} onChange={(event) => setRole(event.target.value as HumanRole)}>
                {humanRoleOptions.map((option) => <option key={option} value={option}>{humanRoleLabels[option]}（{workspaceHumanRoleDescriptions[option]}）</option>)}
              </Select>
            </Field>
            <div className="form-actions">
              <Button type="submit" pending={isSubmitting} disabled={humanUserId === ""}>{isSubmitting ? "追加中..." : "Workspaceに追加"}</Button>
            </div>
          </form>
        </>
      )}
      {notice && <p className="grant-notice" role="status">{notice}</p>}
    </>
  );
};

/**
 * Workspace Membership（handoff v2「14.1 Human」）。一覧はviewer以上、追加・Role変更・取消はownerだけに出す。
 * `readOnly`（archivedのWorkspace）では一覧だけを表示する。Project Membershipとは別で、所属ProjectのWorkの権限を与えない。
 * 自分のRole変更・取消の後は`onSelfChanged`でWorkspace（`myRole`）を読み直し、導線を新しいRoleへ揃える。
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
  const scope: MemberScope = { kind: "workspace", id: workspaceId };
  const [members, setMembers] = useState<Member[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const load = useCallback(
    () =>
      request<{ members: Member[] }>(scopeMembersPath({ kind: "workspace", id: workspaceId }))
        .then((body) => { setMembers(body.members); setLoadError(null); setRevision((current) => current + 1); })
        .catch((reason: unknown) => setLoadError(loadFailureMessage(classifyError(reason), notFound))),
    [workspaceId],
  );
  useEffect(() => { void load(); }, [load]);
  const editable = manage && !readOnly;
  return (
    <section className="detail-section" aria-labelledby="workspace-member-heading">
      <h2 id="workspace-member-heading">Member</h2>
      <p className="section-note">
        このWorkspace（Mission・Direction・Project一覧）を利用できるHumanです。Workspace MembershipはProject Membershipと別で、所属ProjectのStory・Taskを操作する権限を与えません。
        {manage ? "Role変更・取消は次の操作から反映されます。" : "Memberの追加・Role変更はWorkspaceのownerが行います。"}
      </p>
      {loadError ? <ErrorState message={`Memberの読み込みに失敗しました: ${loadError}`} /> : members === null ? <Loading /> : (
        <ul className="grant-list" aria-labelledby="workspace-member-heading">
          {members.map((member) => <MemberRow key={member.membership.id} scope={scope} member={member} members={members} isSelf={member.human.id === currentHumanId} manage={editable} onChanged={() => (member.human.id === currentHumanId ? onSelfChanged() : void load())} />)}
        </ul>
      )}
      {editable && <AddMemberForm workspaceId={workspaceId} membersRevision={revision} onAdded={load} />}
    </section>
  );
};
