import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams } from "react-router-dom";
import { ApiError, classifyError, describeActionFailure, jsonPost, loadFailureMessage, request, type ErrorKind } from "../../api";
import { ConfirmPanel, ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, Field, Select, TextArea, TextInput } from "../../components/ui";
import { consultationInboxPath, projectViewPath, workspacePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { canOperate, canOperateWorkspace, projectOperationAccess, projectOperationDeniedMessage, type ProjectOperationAccess } from "../access";
import { formatTime } from "../execution";
import { scopeMembersPath, type HumanRole, type Member } from "../member";
import { ConsultationFollowupSection } from "./ConsultationFollowupSection";
import {
  basisSequences,
  consultationApiPath,
  consultationDetailPath,
  consultationListPath,
  consultationScopeApiPath,
  consultationScopeLabels,
  consultationStatusLabels,
  consultationStatusTones,
  describeActor,
  describeConsultationReference,
  isOpenConsultation,
  messageAnchorId,
  messageKindLabel,
  newRequestId,
  projectConsultationScope,
  resolutionSourceLabels,
  workspaceConsultationScope,
  type ConsultationDetail,
  type ConsultationMessage,
  type ConsultationResourceLink,
  type ConsultationScope,
} from "./consultation";

/**
 * 相談詳細が読むscopeの項目。Projectは`GET /api/projects/:projectId`（Repository・Resourceは参照の表示先）、
 * Workspaceは`GET /api/workspaces/:workspaceId`。`myRole`はscopeのMembershipのRoleで、互いに継承しない。
 */
type ScopeResponse =
  | { project: { name: string; status: "active" | "archived"; repositories: ConsultationResourceLink[]; resources: ConsultationResourceLink[] }; myRole: HumanRole }
  | { workspace: { name: string; status: "active" | "archived" }; myRole: HumanRole };
type ScopeFacts = { name: string; status: "active" | "archived"; resources: ConsultationResourceLink[] | null; myRole: HumanRole };

const scopeFactsOf = (response: ScopeResponse): ScopeFacts =>
  "project" in response
    ? { name: response.project.name, status: response.project.status, resources: [...response.project.repositories, ...response.project.resources], myRole: response.myRole }
    : { name: response.workspace.name, status: response.workspace.status, resources: null, myRole: response.myRole };

const scopeKey = (scope: ConsultationScope) => (scope.kind === "project" ? `project/${scope.projectId}` : `workspace/${scope.workspaceId}`);

/** 会話の再読込の間隔。Agentの応答は非同期のため、開いている間だけ定期的に読み直す。 */
const pollIntervalMs = 15_000;

const notFoundMessage = (scope: ConsultationScope) => {
  const label = consultationScopeLabels[scope.kind];
  return `相談が見つかりません。別の${label}の相談か、この${label}を閲覧する権限がありません。`;
};

/** 未所属・存在しないscopeと、別scopeの相談IDはどちらも404（serverが区別を漏らさない）。 */
const detailLoadFailure = (scope: ConsultationScope, reason: unknown) =>
  reason instanceof ApiError && reason.status === 404 ? notFoundMessage(scope) : loadFailureMessage(classifyError(reason), notFoundMessage(scope));

/** 返信・決定・取消の失敗。版の競合は最新を読み直させ、入力は呼出し側で残す。 */
const describeOperationFailure = (scope: ConsultationScope) => (classified: ErrorKind) => describeActionFailure(classified, notFoundMessage(scope));

/** 入力を保ったまま再試行するときは同じ`requestId`で送り、入力を変えたら新しくする（再送で発言・結論を重複させない）。 */
const useRequestId = () => {
  const ref = useRef(newRequestId());
  return { current: () => ref.current, renew: () => { ref.current = newRequestId(); } };
};

/** 失敗の表示。表示のたびにfocusを移し、keyboard・読み上げで失敗を先に伝える。 */
const OperationError = ({ id, message }: { id: string; message: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.focus(), [message]);
  return <StateCard ref={ref} tabIndex={-1} id={id} tone="error" role="alert">{message}</StateCard>;
};

/** Humanの返信。送信するとAgentの応答待ちになる。失敗時は入力を残し、成功時だけ空にする。 */
const ReplyForm = ({ scope, consultationId, onSaved }: { scope: ConsultationScope; consultationId: string; onSaved: () => Promise<void> }) => {
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const requestId = useRequestId();
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!body.trim()) {
      setError("返信を入力してください。");
      return;
    }
    setError(null);
    setSent(false);
    setPending(true);
    try {
      await request(consultationApiPath(scope, consultationId, "/messages"), jsonPost({ body, requestId: requestId.current() }));
      requestId.renew();
      setBody("");
      setSent(true);
      await onSaved();
    } catch (reason) {
      setError(describeOperationFailure(scope)(classifyError(reason)));
    } finally {
      setPending(false);
    }
  };
  return (
    <form className="grant-form" onSubmit={submit} noValidate>
      <Field label="返信" required description="質問への回答・確認したいことを書きます。返信するとAgentが内容を読んで回答・追加質問・結論の整理を行います。明確に方針を決める場合は、administrator以上が「この方針で決定」から記録できます。">
        <TextArea
          id="consultation-reply-body"
          required
          maxLength={20000}
          rows={4}
          value={body}
          {...(error ? { "aria-invalid": true, "aria-describedby": "consultation-reply-error" } : {})}
          onChange={(event) => { setBody(event.target.value); setSent(false); requestId.renew(); }}
        />
      </Field>
      {error && <OperationError id="consultation-reply-error" message={error} />}
      <div className="form-actions">
        <Button type="submit" pending={pending}>{pending ? "送信中..." : "返信する"}</Button>
      </div>
      {sent && <p className="grant-notice" role="status">返信しました。Agentの応答を待っています。</p>}
    </form>
  );
};

/** Humanの明示決定。表示中の版を送り、他の返信・応答で版が進んでいれば拒否される（最新を読んでから決める）。 */
const DecisionPanel = ({ scope, detail, onCancel, onSaved }: { scope: ConsultationScope; detail: ConsultationDetail; onCancel: () => void; onSaved: () => Promise<void> }) => {
  const { consultation } = detail;
  const [conclusion, setConclusion] = useState("");
  const [rationale, setRationale] = useState("");
  const [applicability, setApplicability] = useState("");
  const [selectedOption, setSelectedOption] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRequestId();
  const edit = (setter: (value: string) => void) => (value: string) => { setter(value); requestId.renew(); };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!conclusion.trim() || !rationale.trim()) {
      setError("結論と判断の根拠を入力してください。");
      return;
    }
    setError(null);
    setPending(true);
    try {
      await request(consultationApiPath(scope, consultation.id, "/resolution"), jsonPost({
        conclusion,
        rationale,
        applicability: applicability.trim() || null,
        selectedOption: selectedOption === "" ? null : Number(selectedOption),
        expectedRevision: consultation.revision,
        requestId: requestId.current(),
      }));
      await onSaved();
    } catch (reason) {
      const classified = classifyError(reason);
      setError(describeOperationFailure(scope)(classified));
      // 版の競合は最新の会話を読み直す。入力は残し、読んだうえで再度決定できる。
      if (classified.kind === "conflict") { requestId.renew(); await onSaved().catch(() => undefined); }
    } finally {
      setPending(false);
    }
  };
  return (
    <ConfirmPanel
      title="この方針で決定しますか？"
      description="Humanの決定として結論を記録し、相談を解決します。Agentはこの結論に従って作業を進めます。解決後に方針を変える場合は、この相談を参照する新しい相談として扱います。"
      error={error}
      onSubmit={submit}
      onCancel={onCancel}
      submitLabel={pending ? "記録中..." : "決定を記録する"}
      pending={pending}
    >
      {consultation.options.length > 0 && (
        <Field label="採用する選択肢">
          <Select value={selectedOption} onChange={(event) => edit(setSelectedOption)(event.target.value)}>
            <option value="">選択肢に依らない</option>
            {consultation.options.map((option, index) => <option key={index} value={String(index)}>{option.label}</option>)}
          </Select>
        </Field>
      )}
      <Field label="結論" required>
        <TextArea autoFocus required maxLength={5000} rows={3} value={conclusion} onChange={(event) => edit(setConclusion)(event.target.value)} />
      </Field>
      <Field label="判断の根拠" required>
        <TextArea required maxLength={10000} rows={3} value={rationale} onChange={(event) => edit(setRationale)(event.target.value)} />
      </Field>
      <Field label="適用範囲" description="この結論を適用する範囲（任意）。">
        <TextInput maxLength={2000} value={applicability} onChange={(event) => edit(setApplicability)(event.target.value)} />
      </Field>
    </ConfirmPanel>
  );
};

const MessageItem = ({ message, messages, names }: { message: ConsultationMessage; messages: readonly ConsultationMessage[]; names?: ReadonlyMap<string, string> }) => {
  const corrected = message.correctsMessageId ? messages.find((item) => item.id === message.correctsMessageId) : undefined;
  return (
    <li id={messageAnchorId(message.id)} className={`consultation-message ${message.author.kind === "human" ? "from-human" : "from-agent"}`}>
      <p className="consultation-message-head">
        <span className="status-badge muted">#{message.sequence} {messageKindLabel(message)}</span>
        <small>{describeActor(message.author, names)} ・ {formatTime(message.createdAt)}</small>
      </p>
      {corrected && <p className="section-note">訂正元: <a href={`#${messageAnchorId(corrected.id)}`}>#{corrected.sequence}</a></p>}
      <p className="pre-wrap">{message.body}</p>
    </li>
  );
};

/** 質問・選択肢・推奨・影響・参照と、方針変更元の相談。 */
const QuestionFacts = ({ scope, detail, resources }: { scope: ConsultationScope; detail: ConsultationDetail; resources: readonly ConsultationResourceLink[] | null }) => {
  const { consultation } = detail;
  return (
    <section className="detail-section" aria-labelledby="consultation-question-heading">
      <h2 id="consultation-question-heading">判断したいこと</h2>
      <p className="pre-wrap">{consultation.question}</p>
      <dl className="intent-facts">
        <dt>進めない理由</dt>
        <dd className="pre-wrap">{consultation.blockingReason}</dd>
        <dt>選択肢</dt>
        <dd>{consultation.options.length ? <ol className="consultation-options">{consultation.options.map((option, index) => <li key={index}><strong>{option.label}</strong>{option.description && <> — {option.description}</>}</li>)}</ol> : <span className="unset">選択肢はありません</span>}</dd>
        <dt>Agentの推奨</dt>
        <dd className="pre-wrap">{consultation.recommendation}</dd>
        <dt>影響</dt>
        <dd className="pre-wrap">{consultation.impact}</dd>
        <dt>参照</dt>
        <dd>
          {consultation.refs.length ? (
            <ul className="consultation-refs">
              {consultation.refs.map((reference, index) => {
                const view = describeConsultationReference(scope, reference, resources);
                const label = view.href
                  ? <a href={view.href} target="_blank" rel="noreferrer">{view.label}<span className="visually-hidden">（外部の正本を新しいタブで開く）</span></a>
                  : view.to ? <Link to={view.to}>{view.label}</Link> : <code>{view.label}</code>;
                return <li key={index}>{label}{view.detail && <> <code>{view.detail}</code></>}</li>;
              })}
            </ul>
          ) : <span className="unset">参照はありません</span>}
        </dd>
        {consultation.supersedesConsultationId && <><dt>方針変更元</dt><dd><Link to={consultationDetailPath(scope, consultation.supersedesConsultationId)}>元の相談を開く</Link></dd></>}
        <dt>起票</dt>
        <dd>{describeActor(consultation.createdBy)} ・ {formatTime(consultation.createdAt)}</dd>
      </dl>
    </section>
  );
};

/** 結論（判断の由来・記録主体・根拠の発言）または取消の理由。 */
const Outcome = ({ detail, names }: { detail: ConsultationDetail; names?: ReadonlyMap<string, string> }) => {
  const { consultation, resolution, messages } = detail;
  if (resolution) {
    const basis = basisSequences(resolution, messages);
    const option = resolution.selectedOption === null ? null : consultation.options[resolution.selectedOption];
    return (
      <section className="detail-section consultation-resolution" aria-labelledby="consultation-resolution-heading">
        <h2 id="consultation-resolution-heading">結論</h2>
        <p><span className={statusBadgeClass(resolution.source === "human_decision" ? "done" : "progress")}>{resolutionSourceLabels[resolution.source]}</span></p>
        <p className="pre-wrap">{resolution.conclusion}</p>
        <dl className="intent-facts">
          {option && <><dt>採用した選択肢</dt><dd>{option.label}</dd></>}
          <dt>判断の根拠</dt>
          <dd className="pre-wrap">{resolution.rationale}</dd>
          {resolution.applicability && <><dt>適用範囲</dt><dd className="pre-wrap">{resolution.applicability}</dd></>}
          <dt>根拠の会話</dt>
          <dd>{basis.length ? basis.map((sequence, index) => <span key={sequence}>{index > 0 && "、"}<a href={`#${messageAnchorId(messages.find((message) => message.sequence === sequence)!.id)}`}>#{sequence}</a></span>) : <span className="unset">決定そのものがHumanの判断です</span>}（版 {resolution.basisRevision} 時点）</dd>
          <dt>記録</dt>
          <dd>{describeActor(resolution.recordedBy, names)} ・ {formatTime(resolution.createdAt)}</dd>
        </dl>
      </section>
    );
  }
  if (consultation.cancellation) {
    return (
      <section className="detail-section" aria-labelledby="consultation-cancel-heading">
        <h2 id="consultation-cancel-heading">取消の理由</h2>
        <p className="pre-wrap">{consultation.cancellation.reason}</p>
        <p className="section-note">{describeActor(consultation.cancellation.by, names)} ・ {formatTime(consultation.cancellation.at)}</p>
      </section>
    );
  }
  return null;
};

/**
 * 相談の詳細。上段に質問・選択肢・推奨・影響・参照、下段に会話と返信を出し、Humanの発言とAgentの発言・要約を区別する。
 * Project相談（`/projects/:projectId/consultations/:id`）とWorkspace相談（`/workspaces/:workspaceId/consultations/:id`）で共有し、
 * 導線はscopeのMembershipで出し分ける（editor以上は返信、administrator以上は明示決定・取消。archived・解決済みでは出さない）。拒否は常にserverが行う。
 */
export const ConsultationDetailPage = () => {
  const { projectId, workspaceId, consultationId = "" } = useParams();
  const scope = workspaceId !== undefined ? workspaceConsultationScope(workspaceId) : projectConsultationScope(projectId ?? "");
  const key = `${scopeKey(scope)}/${consultationId}`;
  const [state, setState] = useState<{ key: string; detail: ConsultationDetail | null; error: string | null } | null>(null);
  const [facts, setFacts] = useState<{ scopeKey: string; facts: ScopeFacts } | null>(null);
  const [humanNames, setHumanNames] = useState<{ scopeKey: string; names: ReadonlyMap<string, string> } | null>(null);
  const [deciding, setDeciding] = useState(false);
  const load = useCallback(
    () => request<ConsultationDetail>(consultationApiPath(scope, consultationId)).then((detail) => setState({ key, detail, error: null })),
    [key],
  );
  useEffect(() => {
    let current = true;
    const fetchDetail = () =>
      request<ConsultationDetail>(consultationApiPath(scope, consultationId))
        .then((detail) => { if (current) setState({ key, detail, error: null }); })
        .catch((reason: unknown) => { if (current) setState((previous) => previous?.key === key && previous.detail ? previous : { key, detail: null, error: detailLoadFailure(scope, reason) }); });
    void fetchDetail();
    // 開いている間だけ定期的に読み直す（Agentの応答は非同期）。読み直しの失敗では表示中の内容を消さない。
    const timer = setInterval(() => { if (document.visibilityState === "visible") void fetchDetail(); }, pollIntervalMs);
    return () => { current = false; clearInterval(timer); };
  }, [key]);
  useEffect(() => {
    let current = true;
    const currentKey = scopeKey(scope);
    request<ScopeResponse>(consultationScopeApiPath(scope))
      .then((response) => { if (current) setFacts({ scopeKey: currentKey, facts: scopeFactsOf(response) }); })
      .catch(() => undefined);
    const memberScope = scope.kind === "project" ? { kind: "project" as const, id: scope.projectId } : { kind: "workspace" as const, id: scope.workspaceId };
    request<{ members: Member[] }>(scopeMembersPath(memberScope))
      .then(({ members }) => { if (current) setHumanNames({ scopeKey: currentKey, names: new Map(members.map((member) => [member.human.id, member.human.displayName])) }); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [scopeKey(scope)]);
  const cancel = useReasonAction(async (reason) => {
    if (!reason.trim()) throw new Error("取消の理由を入力してください。");
    const detail = state?.detail;
    if (!detail) return;
    try {
      await request(consultationApiPath(scope, consultationId, "/cancel"), jsonPost({ reason, expectedRevision: detail.consultation.revision, requestId: newRequestId() }));
    } finally {
      await load().catch(() => undefined);
    }
  }, describeOperationFailure(scope));

  const settled = state?.key === key ? state : null;
  const detail = settled?.detail ?? null;
  const scopeFacts = facts?.scopeKey === scopeKey(scope) ? facts.facts : null;
  const names = humanNames?.scopeKey === scopeKey(scope) ? humanNames.names : undefined;
  const label = consultationScopeLabels[scope.kind];
  const access = (operation: "consultation.reply" | "consultation.decide"): ProjectOperationAccess | null =>
    scopeFacts
      ? projectOperationAccess(scopeFacts, scope.kind === "project" ? canOperate(scopeFacts.myRole, operation) : canOperateWorkspace(scopeFacts.myRole, operation))
      : null;
  const open = detail ? isOpenConsultation(detail.consultation.status) : false;
  const replyAccess = access("consultation.reply");
  const decideAccess = access("consultation.decide");
  const scopeHome = scope.kind === "project" ? projectViewPath(scope.projectId, "overview") : workspacePath(scope.workspaceId);
  const saved = async () => {
    setDeciding(false);
    await load().catch(() => undefined);
  };
  return (
    <main className="narrow">
      <Link to={consultationListPath(scope)} className="back-link">← 判断待ち</Link>
      {settled?.error ? (
        <>
          <ErrorState message={settled.error} />
          <p className="section-note"><Link to={consultationInboxPath} className="text-link">閲覧できる判断待ちの一覧へ →</Link></p>
        </>
      ) : !detail ? (
        <Loading />
      ) : (
        <>
          <nav className="breadcrumb" aria-label="現在位置">
            <ol>
              <li><Link to={scopeHome}>{scopeFacts?.name ?? label}</Link></li>
              <li><Link to={consultationListPath(scope)}>判断待ち</Link></li>
              <li aria-current="page">{detail.consultation.title}</li>
            </ol>
          </nav>
          <div className="detail-hero">
            <p className="eyebrow">{label}の相談</p>
            <h1>{detail.consultation.title}</h1>
            <p><span className={statusBadgeClass(consultationStatusTones[detail.consultation.status])}>{consultationStatusLabels[detail.consultation.status]}</span></p>
            <time>{formatTime(detail.consultation.updatedAt)} 更新（版 {detail.consultation.revision}）</time>
            {detail.responder && <p className="section-note">{describeActor({ kind: "agent", principalId: detail.responder.principalId, role: detail.responder.role })}が応答中です（期限 {formatTime(detail.responder.expiresAt)}）。</p>}
            {open && decideAccess === "allowed" && (
              <div className="action-row">
                <Button aria-expanded={deciding} onClick={() => { cancel.cancel(); setDeciding(true); }}>この方針で決定</Button>
                <Button variant="secondary" tone="danger" aria-expanded={cancel.confirming} onClick={() => { setDeciding(false); cancel.open(); }}>相談を取消</Button>
              </div>
            )}
            {open && deciding && decideAccess === "allowed" && <DecisionPanel scope={scope} detail={detail} onCancel={() => setDeciding(false)} onSaved={saved} />}
            {open && cancel.confirming && decideAccess === "allowed" && (
              <ReasonPanel action={cancel} title="この相談を取り消しますか？" description="不要になった相談を閉じます。取り消すと返信・決定はできません。理由は相談に残ります。" label="取消の理由" required confirmLabel="取り消す" pendingLabel="取消中..." />
            )}
          </div>
          <QuestionFacts scope={scope} detail={detail} resources={scopeFacts?.resources ?? null} />
          <Outcome detail={detail} names={names} />
          <ConsultationFollowupSection detail={detail} />
          <section className="detail-section" aria-labelledby="consultation-messages-heading">
            <h2 id="consultation-messages-heading">会話</h2>
            <p className="section-note">Humanの返信とAgentの回答・追加質問です。発言は書き換えられず、訂正は新しい発言として残ります。</p>
            {detail.messages.length ? (
              <ol className="consultation-messages">
                {detail.messages.map((message) => <MessageItem key={message.id} message={message} messages={detail.messages} names={names} />)}
              </ol>
            ) : (
              <p className="unset">まだ返信はありません</p>
            )}
            {open && replyAccess === "allowed" && <ReplyForm scope={scope} consultationId={consultationId} onSaved={saved} />}
            {open && replyAccess !== null && replyAccess !== "allowed" && <p className="section-note">{projectOperationDeniedMessage(replyAccess, label)}</p>}
            {!open && <p className="section-note">この相談は{consultationStatusLabels[detail.consultation.status]}です。方針を変える場合は、Agentがこの相談を参照する新しい相談を登録します。</p>}
          </section>
        </>
      )}
    </main>
  );
};
