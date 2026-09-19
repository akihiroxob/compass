import { StrictMode, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { ApiError, classifyError, fieldId, request, type ErrorKind } from "./api";
import { emptyIntentFormValues, formValuesFromIntent, intentStatusLabels, splitIntents, type Intent, type IntentFormValues } from "./intentForm";
import { emptyOutcomeFormValues, emptyCriterion, formValuesFromOutcome, maxSuccessCriteria, outcomeStatusLabels, splitOutcomes, type Outcome, type OutcomeFormValues } from "./outcomeForm";
import { emptyFormValues, formValuesFromProject, type LinkInput, type Project, type ProjectFormValues } from "./projectForm";
import "./styles.css";

type FieldProps = { id: string; "aria-invalid"?: true; "aria-describedby"?: string };
const summaryId = "form-error-summary";
const fieldProps = (invalid: ReadonlySet<string>, id: string): FieldProps => invalid.has(id) ? { id, "aria-invalid": true, "aria-describedby": summaryId } : { id };

const Shell = ({ children }: { children: ReactNode }) => <><header className="site-header"><Link to="/" className="brand"><span>◒</span> Compass</Link><p>Direction workspace</p></header>{children}</>;
const Loading = () => <div className="state-card" role="status">読み込み中...</div>;
const ErrorState = ({ message }: { message: string }) => <div className="state-card error" role="alert">{message}</div>;

const ProjectListPage = () => {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ projects: Project[] }>("/api/projects").then(({ projects }) => setProjects(projects)).catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "other" ? classified.message : "不明なエラー"); }); }, []);
  return <Shell><main><div className="page-heading"><div><p className="eyebrow">Projects</p><h1>進む理由を、見失わない。</h1></div><Link to="/projects/new" className="button">Projectを作成</Link></div><p className="lede">MissionとVisionを軸に、判断の原則・制約・参照先をひとつの場所にまとめます。</p>
    {error ? <ErrorState message={`Projectの読み込みに失敗しました: ${error}`} /> : projects === null ? <Loading /> : projects.length === 0 ? <div className="state-card"><h2>最初のProjectを作成しましょう</h2><p>この現場が存在する理由から始めます。</p><Link to="/projects/new" className="text-link">作成フォームを開く →</Link></div> : <section className="project-grid" aria-label={`${projects.length}件のProject`}>{projects.map((project) => <Link className="project-card" to={`/projects/${project.id}`} key={project.id}><p className="card-label">Project</p><h2>{project.name}</h2>{project.description && <p>{project.description}</p>}<div className="mission-preview"><span>Mission</span>{project.mission}</div><time>{new Date(project.updatedAt).toLocaleDateString("ja-JP")} 更新</time></Link>)}</section>}
  </main></Shell>;
};

const TextListInput = ({ legend, name, values, setValues, placeholder, invalid }: { legend: string; name: string; values: string[]; setValues: (values: string[]) => void; placeholder: string; invalid: ReadonlySet<string> }) => <fieldset className="repeat-field"><legend>{legend}</legend>{values.map((value, index) => <div className="repeat-row" key={index}><input {...fieldProps(invalid, fieldId(`${name}.${index}`))} aria-label={`${legend} ${index + 1}`} value={value} placeholder={placeholder} onChange={(event) => setValues(values.map((item, i) => i === index ? event.target.value : item))} /><button type="button" className="remove" onClick={() => setValues(values.filter((_, i) => i !== index))}>削除</button></div>)}<button type="button" className="add-row" onClick={() => setValues([...values, ""])}>＋ {legend}を追加</button></fieldset>;

const LinkListInput = ({ legend, name, values, setValues, invalid, withKind = false }: { legend: string; name: string; values: LinkInput[]; setValues: (values: LinkInput[]) => void; invalid: ReadonlySet<string>; withKind?: boolean }) => <fieldset className="repeat-field"><legend>{legend}</legend>{values.map((value, index) => <div className="repeat-row links" key={index}><input {...fieldProps(invalid, fieldId(`${name}.${index}.name`))} aria-label={`${legend} ${index + 1}の名前`} value={value.name} placeholder="名前" onChange={(event) => setValues(values.map((item, i) => i === index ? { ...item, name: event.target.value } : item))} /><input {...fieldProps(invalid, fieldId(`${name}.${index}.url`))} aria-label={`${legend} ${index + 1}のURL`} type="url" value={value.url} placeholder="https://..." onChange={(event) => setValues(values.map((item, i) => i === index ? { ...item, url: event.target.value } : item))} />{withKind && <input {...fieldProps(invalid, fieldId(`${name}.${index}.kind`))} aria-label={`${legend} ${index + 1}の種類`} value={value.kind} placeholder="種類（任意）" onChange={(event) => setValues(values.map((item, i) => i === index ? { ...item, kind: event.target.value } : item))} />}<button type="button" className="remove" onClick={() => setValues(values.filter((_, i) => i !== index))}>削除</button></div>)}<button type="button" className="add-row" onClick={() => setValues([...values, { name: "", url: "", kind: "" }])}>＋ {legend}を追加</button></fieldset>;

type FormError = Exclude<ErrorKind, { kind: "not_found" }>;
type ProjectFormProps = { initial: ProjectFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: ProjectFormValues) => Promise<Project> };

const ProjectForm = ({ initial, heading, submitLabel, pendingLabel, cancelTo, save }: ProjectFormProps) => {
  const navigate = useNavigate(); const [name, setName] = useState(initial.name); const [description, setDescription] = useState(initial.description); const [mission, setMission] = useState(initial.mission); const [vision, setVision] = useState(initial.vision); const [principles, setPrinciples] = useState(initial.principles); const [constraints, setConstraints] = useState(initial.constraints); const [repositories, setRepositories] = useState(initial.repositories); const [resources, setResources] = useState(initial.resources); const [error, setError] = useState<FormError | null>(null); const [isSubmitting, setIsSubmitting] = useState(false); const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: "center" }); } }, [error]);
  const invalid: ReadonlySet<string> = new Set(error?.kind === "validation" ? error.issues.flatMap((issue) => issue.fieldId ? [issue.fieldId] : []) : []);
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const project = await save({ name, description, mission, vision, principles, constraints, repositories, resources }); navigate(`/projects/${project.id}`); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "validation" ? classified : { kind: "other", message: classified.kind === "other" ? classified.message : "Projectが見つかりません。削除された可能性があります。" }); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← {cancelTo === "/" ? "Project一覧" : "Project詳細"}</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>{error && <div className="state-card error" role="alert" id={summaryId} tabIndex={-1} ref={errorRef}>{error.kind === "validation" ? <><p className="error-title">入力内容を確認してください</p><ul>{error.issues.map((issue, index) => <li key={index}>{issue.fieldId ? <a href={`#${issue.fieldId}`}>{issue.label}</a> : issue.label}: {issue.message}</li>)}</ul></> : <><p className="error-title">保存に失敗しました。時間をおいて再試行してください。</p><p>{error.message}</p></>}</div>}<form onSubmit={submit} className="project-form">
    <section className="form-section"><h2>Identity</h2><label>Project名 <span>必須</span><input {...fieldProps(invalid, "field-name")} required aria-required="true" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label><label>説明<textarea {...fieldProps(invalid, "field-description")} maxLength={1000} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label></section>
    <section className="form-section"><h2>Direction</h2><label>Mission <span>必須</span><small>このProjectが存在する理由</small><textarea {...fieldProps(invalid, "field-mission")} required aria-required="true" maxLength={2000} rows={5} value={mission} onChange={(event) => setMission(event.target.value)} /></label><label>Vision<small>最終的に実現したい状態</small><textarea {...fieldProps(invalid, "field-vision")} maxLength={2000} rows={5} value={vision} onChange={(event) => setVision(event.target.value)} /></label><TextListInput legend="Principles" name="principles" invalid={invalid} values={principles} setValues={setPrinciples} placeholder="迷ったときの判断原則" /><TextListInput legend="Constraints" name="constraints" invalid={invalid} values={constraints} setValues={setConstraints} placeholder="超えてはいけない制約" /></section>
    <section className="form-section"><h2>References</h2><LinkListInput legend="Repositories" name="repositories" invalid={invalid} values={repositories} setValues={setRepositories} /><LinkListInput legend="Resources" name="resources" invalid={invalid} values={resources} setValues={setResources} withKind /></section>
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};

const jsonInit = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const ProjectCreatePage = () => <ProjectForm initial={emptyFormValues} heading={{ eyebrow: "New project", title: "Projectを作成", lede: "必須なのは名前、Missionです。ほかの情報も今ここで整理できます。" }} submitLabel="Projectを作成" pendingLabel="作成中..." cancelTo="/" save={async (values) => (await request<{ project: Project }>("/api/projects", jsonInit("POST", values))).project} />;

const ProjectEditPage = () => {
  const { projectId = "" } = useParams(); const [project, setProject] = useState<Project | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ project: Project }>(`/api/projects/${projectId}`).then(({ project }) => setProject(project)).catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "not_found" ? "Projectが見つかりません。" : `読み込みに失敗しました: ${classified.kind === "other" ? classified.message : "入力内容が不正です"}`); }); }, [projectId]);
  if (error) return <Shell><main className="narrow"><Link to="/" className="back-link">← Project一覧</Link><ErrorState message={error} /></main></Shell>;
  if (!project) return <Shell><main className="narrow"><Loading /></main></Shell>;
  return <ProjectForm initial={formValuesFromProject(project)} heading={{ eyebrow: "Edit project", title: "Projectを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={`/projects/${project.id}`} save={async (values) => (await request<{ project: Project }>(`/api/projects/${project.id}`, jsonInit("PATCH", values))).project} />;
};

const ListSection = ({ title, values }: { title: string; values: string[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <ul>{values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}</ul> : <p className="unset">未設定</p>}</section>;
const ProjectDetailPage = () => { const { projectId = "" } = useParams(); const [project, setProject] = useState<Project | null>(null); const [error, setError] = useState<string | null>(null); useEffect(() => { request<{ project: Project }>(`/api/projects/${projectId}`).then(({ project }) => setProject(project)).catch((reason: unknown) => { const classified = classifyError(reason); setError(classified.kind === "not_found" ? "Projectが見つかりません。" : `読み込みに失敗しました: ${classified.kind === "other" ? classified.message : "入力内容が不正です"}`); }); }, [projectId]); return <Shell><main className="narrow"><Link to="/" className="back-link">← Project一覧</Link>{error ? <ErrorState message={error} /> : !project ? <Loading /> : <><div className="detail-hero"><p className="eyebrow">Project</p><h1>{project.name}</h1>{project.description && <p className="lede">{project.description}</p>}<time>{new Date(project.updatedAt).toLocaleString("ja-JP")} 更新</time><Link to={`/projects/${project.id}/edit`} className="button">Projectを編集</Link></div><section className="direction-panel"><div><p className="section-label">Mission</p><p>{project.mission}</p></div><div><p className="section-label">Vision</p><p>{project.vision ?? <span className="unset">未設定</span>}</p></div></section><IntentSection projectId={project.id} /><div className="detail-columns"><ListSection title="Principles" values={project.principles} /><ListSection title="Constraints" values={project.constraints} /></div><LinkSection title="Repositories" values={project.repositories} /><LinkSection title="Resources" values={project.resources} /></>}</main></Shell>; };
const LinkSection = ({ title, values }: { title: string; values: ({ id: string; name: string; url: string; kind?: string | null })[] }) => <section className="detail-section"><h2>{title}</h2>{values.length ? <div className="link-list">{values.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.id}><span>{item.name}</span><small>{item.kind || item.url}</small></a>)}</div> : <p className="unset">未設定</p>}</section>;

// ---- Intent（Step 2）。Strategist・Research・Outcomeは未実装のため、状態や進行を表示しない。 ----
const loadFailureMessage = (classified: ErrorKind, notFound: string) => classified.kind === "not_found" ? notFound : classified.kind === "validation" ? "入力内容が不正です" : classified.message;
const intentPath = (projectId: string, intentId?: string, suffix = "") => `/projects/${projectId}/intents${intentId ? `/${intentId}` : ""}${suffix}`;
const jsonPost = (body?: unknown): RequestInit => body === undefined ? { method: "POST" } : jsonInit("POST", body);

const IntentFacts = ({ intent }: { intent: Intent }) => <dl className="intent-facts"><dt>実現したい状態</dt><dd>{intent.desiredState}</dd><dt>完了の定義</dt><dd>{intent.completionDefinition ?? <span className="unset">未設定</span>}</dd></dl>;

const IntentSection = ({ projectId }: { projectId: string }) => {
  const [intents, setIntents] = useState<Intent[] | null>(null); const [error, setError] = useState<string | null>(null);
  useEffect(() => { request<{ intents: Intent[] }>(`/api/projects/${projectId}/intents`).then(({ intents }) => setIntents(intents)).catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。"))); }, [projectId]);
  const { active, past } = splitIntents(intents ?? []);
  return <section className="detail-section intent-section" aria-labelledby="intent-heading"><h2 id="intent-heading">Intent</h2><p className="section-note">Humanが今実現したい状態です。Missionとは別に、達成や放棄で終わります。</p>
    {error ? <ErrorState message={`Intentの読み込みに失敗しました: ${error}`} /> : intents === null ? <Loading /> : <>
      {active ? <article className="intent-card"><span className="status-badge">{intentStatusLabels.active}</span><h3>{active.title}</h3><IntentFacts intent={active} /><ActiveOutcomes projectId={projectId} intentId={active.id} /><Link to={intentPath(projectId, active.id)} className="secondary-button">詳細・編集</Link></article> : <div className="intent-empty"><p className="unset">Intentは未登録です</p><Link to={intentPath(projectId, "new")} className="button">Intentを登録</Link></div>}
      {past.length > 0 && <details className="past-intents"><summary>過去のIntent（{past.length}件）</summary><ul>{past.map((intent) => <li key={intent.id}><Link to={intentPath(projectId, intent.id)}><span className="status-badge muted">{intentStatusLabels[intent.status]}</span> {intent.title}</Link></li>)}</ul></details>}
    </>}
  </section>;
};

type IntentFormProps = { projectId: string; initial: IntentFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: IntentFormValues) => Promise<Intent> };

const IntentForm = ({ projectId, initial, heading, submitLabel, pendingLabel, cancelTo, save }: IntentFormProps) => {
  const navigate = useNavigate(); const [title, setTitle] = useState(initial.title); const [desiredState, setDesiredState] = useState(initial.desiredState); const [completionDefinition, setCompletionDefinition] = useState(initial.completionDefinition); const [error, setError] = useState<FormError | null>(null); const [isSubmitting, setIsSubmitting] = useState(false); const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: "center" }); } }, [error]);
  const invalid: ReadonlySet<string> = new Set(error?.kind === "validation" ? error.issues.flatMap((issue) => issue.fieldId ? [issue.fieldId] : []) : []);
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const intent = await save({ title, desiredState, completionDefinition }); navigate(intentPath(projectId, intent.id)); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "not_found" ? { kind: "other", message: "ProjectまたはIntentが見つかりません。削除された可能性があります。" } : classified); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← 戻る</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>
    {error && <div className="state-card error" role="alert" id={summaryId} tabIndex={-1} ref={errorRef}>{error.kind === "validation" ? <><p className="error-title">入力内容を確認してください</p><ul>{error.issues.map((issue, index) => <li key={index}>{issue.fieldId ? <a href={`#${issue.fieldId}`}>{issue.label}</a> : issue.label}: {issue.message}</li>)}</ul></> : error.kind === "conflict" ? <><p className="error-title">この操作は現在のIntentの状態と競合しています。</p><p>{error.message}</p>{error.activeIntentId && <Link to={intentPath(projectId, error.activeIntentId)} className="text-link">Active Intentを開く →</Link>}</> : <><p className="error-title">保存に失敗しました。時間をおいて再試行してください。</p><p>{error.message}</p></>}</div>}
    <form onSubmit={submit} className="project-form"><section className="form-section"><label>タイトル <span>必須</span><small>Intentを一言で表す名前（100文字まで）</small><input {...fieldProps(invalid, "field-title")} required aria-required="true" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label><label>実現したい状態 <span>必須</span><small>Humanが今実現したい状態。実装手段ではなく、実現後の状態を書きます。</small><textarea {...fieldProps(invalid, "field-desiredState")} required aria-required="true" maxLength={2000} rows={6} value={desiredState} onChange={(event) => setDesiredState(event.target.value)} /></label><label>完了の定義<small>何が示されればこのIntent全体が完了と言えるか（任意）</small><textarea {...fieldProps(invalid, "field-completionDefinition")} maxLength={2000} rows={4} value={completionDefinition} onChange={(event) => setCompletionDefinition(event.target.value)} /></label></section>
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};

const IntentCreatePage = () => { const { projectId = "" } = useParams(); return <IntentForm projectId={projectId} initial={emptyIntentFormValues} heading={{ eyebrow: "New intent", title: "Intentを登録", lede: "必須なのはタイトルと実現したい状態です。Activeなintentは1つのProjectにつき1件までです。" }} submitLabel="Intentを登録" pendingLabel="登録中..." cancelTo={`/projects/${projectId}`} save={async (values) => (await request<{ intent: Intent }>(`/api/projects/${projectId}/intents`, jsonPost(values))).intent} />; };

/** サーバーのNOT_FOUNDメッセージ（Project/Intentで先頭語が異なる）から、どちらが存在しないかを区別する。 */
const useIntentPage = (projectId: string, intentId: string) => {
  const [state, setState] = useState<{ intent: Intent | null; error: string | null }>({ intent: null, error: null });
  useEffect(() => { request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}`).then(({ intent }) => setState({ intent, error: null })).catch((reason: unknown) => setState({ intent: null, error: reason instanceof ApiError && reason.status === 404 && reason.message.startsWith("Intent") ? "Intentが見つかりません。" : loadFailureMessage(classifyError(reason), "Projectが見つかりません。") })); }, [projectId, intentId]);
  return { ...state, setIntent: (intent: Intent) => setState({ intent, error: null }) };
};

const IntentEditPage = () => {
  const { projectId = "", intentId = "" } = useParams(); const { intent, error } = useIntentPage(projectId, intentId); const back = intentPath(projectId, intentId);
  if (error) return <Shell><main className="narrow"><Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link><ErrorState message={error} /></main></Shell>;
  if (!intent) return <Shell><main className="narrow"><Loading /></main></Shell>;
  if (intent.status !== "active") return <Shell><main className="narrow"><Link to={back} className="back-link">← Intent詳細</Link><ErrorState message={`${intentStatusLabels[intent.status]}のIntentは編集できません。`} /></main></Shell>;
  return <IntentForm projectId={projectId} initial={formValuesFromIntent(intent)} heading={{ eyebrow: "Edit intent", title: "Intentを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={back} save={async (values) => (await request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}`, jsonInit("PATCH", values))).intent} />;
};

const IntentDetailPage = () => {
  const { projectId = "", intentId = "" } = useParams(); const { intent, error, setIntent } = useIntentPage(projectId, intentId);
  const [confirming, setConfirming] = useState(false); const [reason, setReason] = useState(""); const [isAbandoning, setIsAbandoning] = useState(false); const [abandonError, setAbandonError] = useState<string | null>(null);
  const abandon = async (event: FormEvent) => { event.preventDefault(); setAbandonError(null); setIsAbandoning(true); try { setIntent((await request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}/abandon`, jsonPost({ reason }))).intent); setConfirming(false); } catch (failure) { const classified = classifyError(failure); setAbandonError(classified.kind === "validation" ? classified.issues.map((issue) => `${issue.label}: ${issue.message}`).join(" / ") : classified.kind === "not_found" ? "Intentが見つかりません。" : classified.message); } finally { setIsAbandoning(false); } };
  return <Shell><main className="narrow"><Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link>{error ? <ErrorState message={error} /> : !intent ? <Loading /> : <>
    <div className="detail-hero"><p className="eyebrow">Intent</p><h1>{intent.title}</h1><p><span className={`status-badge${intent.status === "active" ? "" : " muted"}`}>{intentStatusLabels[intent.status]}</span></p><time>{new Date(intent.updatedAt).toLocaleString("ja-JP")} 更新</time></div>
    <section className="detail-section"><IntentFacts intent={intent} /></section>
    <OutcomeSection projectId={projectId} intent={intent} />
    {intent.status === "abandoned" && <section className="detail-section"><h2>放棄</h2><p>{intent.abandonedReason ?? <span className="unset">理由は記録されていません</span>}</p><p className="section-note">放棄したIntentはActiveに戻せません。続ける場合は新しいIntentを登録してください。</p><Link to={intentPath(projectId, "new")} className="secondary-button">新しいIntentを登録</Link></section>}
    {intent.status === "active" && <div className="action-row"><Link to={intentPath(projectId, intent.id, "/edit")} className="button">Intentを編集</Link><button type="button" className="secondary-button danger" aria-expanded={confirming} onClick={() => setConfirming(true)}>Intentを放棄</button></div>}
    {intent.status === "active" && confirming && <form className="abandon-panel" onSubmit={abandon}><h2>このIntentを放棄しますか？</h2><p>放棄すると編集できず、Activeに戻せません。ActiveなOutcomeがあれば同時に取り消されます。新しいIntentを登録してやり直せます。</p><label>放棄の理由（任意）<textarea autoFocus maxLength={2000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{abandonError && <div className="state-card error" role="alert">{abandonError}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setConfirming(false); setAbandonError(null); }}>やめる</button><button className="button danger" disabled={isAbandoning}>{isAbandoning ? "放棄中..." : "放棄する"}</button></div></form>}
  </>}</main></Shell>;
};

// ---- Outcome（Step 3）。Evaluation・Execution・Decision・Research・Strategistは未実装のため、達成率や進行状況を表示しない。 ----
// フォームのエラー要約はProject / Intent / Outcomeで3箇所目の重複。共通化はTask 10の範囲外のため、既存に合わせて複製している。
const outcomePath = (projectId: string, intentId: string, outcomeId?: string, suffix = "") => `${intentPath(projectId, intentId)}/outcomes${outcomeId ? `/${outcomeId}` : ""}${suffix}`;

/** IntentのOutcome一覧の取得。Project詳細とIntent詳細の両方が使う。 */
const useOutcomes = (projectId: string, intentId: string) => {
  const [state, setState] = useState<{ outcomes: Outcome[] | null; error: string | null }>({ outcomes: null, error: null });
  useEffect(() => { request<{ outcomes: Outcome[] }>(`/api/projects/${projectId}/intents/${intentId}/outcomes`).then(({ outcomes }) => setState({ outcomes, error: null })).catch((reason: unknown) => setState({ outcomes: null, error: loadFailureMessage(classifyError(reason), "ProjectまたはIntentが見つかりません。") })); }, [projectId, intentId]);
  return state;
};

const OutcomeLinks = ({ projectId, outcomes }: { projectId: string; outcomes: Outcome[] }) => <ul className="outcome-list">{outcomes.map((outcome) => <li key={outcome.id}><Link to={outcomePath(projectId, outcome.intentId, outcome.id)}><span className={`status-badge${outcome.status === "active" ? "" : " muted"}`}>{outcomeStatusLabels[outcome.status]}</span> {outcome.title}<small>成功条件 {outcome.successCriteria.length}件</small></Link></li>)}</ul>;

/** Project詳細のActive Intent内に表示する、ActiveなOutcomeの一覧。成功条件はOutcome詳細で見る。 */
const ActiveOutcomes = ({ projectId, intentId }: { projectId: string; intentId: string }) => {
  const { outcomes, error } = useOutcomes(projectId, intentId); const { active } = splitOutcomes(outcomes ?? []);
  return <div className="outcome-block"><p className="section-label">Active Outcomes</p>{error ? <p className="unset" role="alert">Outcomeを読み込めませんでした: {error}</p> : outcomes === null ? <p className="unset" role="status">読み込み中...</p> : active.length ? <OutcomeLinks projectId={projectId} outcomes={active} /> : <p className="unset">Outcomeは未登録です</p>}</div>;
};

const OutcomeSection = ({ projectId, intent }: { projectId: string; intent: Intent }) => {
  const { outcomes, error } = useOutcomes(projectId, intent.id); const { active, past } = splitOutcomes(outcomes ?? []);
  return <section className="detail-section" aria-labelledby="outcome-heading"><h2 id="outcome-heading">Outcome</h2><p className="section-note">Intentへ近づくために達成すべき、観測可能な状態です。Strategist（またはHuman）の判断結果として、成功条件とともに登録します。</p>
    {error ? <ErrorState message={`Outcomeの読み込みに失敗しました: ${error}`} /> : outcomes === null ? <Loading /> : <>
      {active.length ? <OutcomeLinks projectId={projectId} outcomes={active} /> : <p className="unset">{past.length ? "ActiveなOutcomeはありません" : "Outcomeは未登録です"}</p>}
      {intent.status === "active" && <div className="action-row"><Link to={outcomePath(projectId, intent.id, "new")} className="button">Outcomeを登録</Link></div>}
      {past.length > 0 && <details className="past-intents"><summary>取消済みなどのOutcome（{past.length}件）</summary><OutcomeLinks projectId={projectId} outcomes={past} /></details>}
    </>}</section>;
};

type OutcomeFormProps = { projectId: string; intentId: string; mode: "create" | "edit"; initial: OutcomeFormValues; heading: { eyebrow: string; title: string; lede: string }; submitLabel: string; pendingLabel: string; cancelTo: string; save: (values: OutcomeFormValues) => Promise<Outcome> };

const OutcomeForm = ({ projectId, intentId, mode, initial, heading, submitLabel, pendingLabel, cancelTo, save }: OutcomeFormProps) => {
  const navigate = useNavigate(); const [title, setTitle] = useState(initial.title); const [description, setDescription] = useState(initial.description); const [hypothesis, setHypothesis] = useState(initial.hypothesis); const [rationale, setRationale] = useState(initial.rationale); const [criteria, setCriteria] = useState(initial.successCriteria); const [error, setError] = useState<FormError | null>(null); const [isSubmitting, setIsSubmitting] = useState(false); const errorRef = useRef<HTMLDivElement>(null);
  useEffect(() => { if (error) { errorRef.current?.focus(); errorRef.current?.scrollIntoView({ block: "center" }); } }, [error]);
  const invalid: ReadonlySet<string> = new Set(error?.kind === "validation" ? error.issues.flatMap((issue) => issue.fieldId ? [issue.fieldId] : []) : []);
  const updateCriterion = (index: number, changes: Partial<(typeof criteria)[number]>) => setCriteria(criteria.map((item, i) => i === index ? { ...item, ...changes } : item));
  // 保存に失敗しても入力state（上のuseState）は維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => { event.preventDefault(); setError(null); setIsSubmitting(true); try { const outcome = await save({ title, description, hypothesis, rationale, successCriteria: criteria }); navigate(outcomePath(projectId, intentId, outcome.id)); } catch (reason) { const classified = classifyError(reason); setError(classified.kind === "not_found" ? { kind: "other", message: "Project、Intent、またはOutcomeが見つかりません。削除された可能性があります。" } : classified); } finally { setIsSubmitting(false); } };
  return <Shell><main className="narrow"><Link to={cancelTo} className="back-link">← 戻る</Link><div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div><p className="lede">{heading.lede}</p>
    {error && <div className="state-card error" role="alert" id={summaryId} tabIndex={-1} ref={errorRef}>{error.kind === "validation" ? <><p className="error-title">入力内容を確認してください</p><ul>{error.issues.map((issue, index) => <li key={index}>{issue.fieldId ? <a href={`#${issue.fieldId}`}>{issue.label}</a> : issue.label}: {issue.message}</li>)}</ul></> : error.kind === "conflict" ? <><p className="error-title">この操作は現在のIntentまたはOutcomeの状態と競合しています。</p><p>{error.message}</p><Link to={intentPath(projectId, intentId)} className="text-link">Intentを開く →</Link></> : <><p className="error-title">保存に失敗しました。時間をおいて再試行してください。</p><p>{error.message}</p></>}</div>}
    <form onSubmit={submit} className="project-form"><section className="form-section"><label>タイトル <span>必須</span><small>Outcomeを一言で表す名前（100文字まで）</small><input {...fieldProps(invalid, "field-title")} required aria-required="true" maxLength={100} value={title} onChange={(event) => setTitle(event.target.value)} /></label>
      {mode === "create" && <><label>達成すべき状態 <span>必須</span><small>Intentへ近づくために達成すべき、観測可能な状態。作成後は変更できません。</small><textarea {...fieldProps(invalid, "field-description")} required aria-required="true" maxLength={2000} rows={5} value={description} onChange={(event) => setDescription(event.target.value)} /></label></>}
      <label>仮説<small>これを達成するとIntentへ近づくと考える理由（任意）</small><textarea {...fieldProps(invalid, "field-hypothesis")} maxLength={2000} rows={3} value={hypothesis} onChange={(event) => setHypothesis(event.target.value)} /></label>
      {mode === "create" && <label>判断理由（Strategistの判断） <span>必須</span><small>Strategist（またはHuman）が、なぜこのOutcomeを今選んだか。判断の記録として作成後は変更できません。</small><textarea {...fieldProps(invalid, "field-rationale")} required aria-required="true" maxLength={2000} rows={4} value={rationale} onChange={(event) => setRationale(event.target.value)} /></label>}</section>
    {mode === "create" ? <section className="form-section"><h2>成功条件</h2><p className="fixed-note">成功条件は作成時に固定され、後から編集できません。変更する場合は、このOutcomeを取り消して新しいOutcomeを作成します。1〜{maxSuccessCriteria}件。</p>
      <fieldset className="repeat-field" {...fieldProps(invalid, "field-successCriteria")}><legend className="visually-hidden">成功条件の一覧</legend>{criteria.map((criterion, index) => <fieldset className="criterion-row" key={index}><legend>成功条件 {index + 1}</legend>
        <label>内容 <span>必須</span><small>何を満たせば成功か（例: duplicate_claim_count = 0）</small><input {...fieldProps(invalid, fieldId(`successCriteria.${index}.description`))} required aria-required="true" maxLength={500} value={criterion.description} onChange={(event) => updateCriterion(index, { description: event.target.value })} /></label>
        <label>測定方法 <span>必須</span><small>どう観測し、どの証拠があれば成立と言えるか。「できた」という主張だけでは成立にできません。</small><textarea {...fieldProps(invalid, fieldId(`successCriteria.${index}.measurement`))} required aria-required="true" maxLength={1000} rows={3} value={criterion.measurement} onChange={(event) => updateCriterion(index, { measurement: event.target.value })} /></label>
        <label>目標値<small>任意（例: = 0、100%）</small><input {...fieldProps(invalid, fieldId(`successCriteria.${index}.target`))} maxLength={200} value={criterion.target} onChange={(event) => updateCriterion(index, { target: event.target.value })} /></label>
        <button type="button" className="remove" disabled={criteria.length <= 1} aria-label={`成功条件 ${index + 1}を削除`} onClick={() => setCriteria(criteria.filter((_, i) => i !== index))}>この成功条件を削除</button></fieldset>)}
        <button type="button" className="add-row" disabled={criteria.length >= maxSuccessCriteria} onClick={() => setCriteria([...criteria, emptyCriterion])}>＋ 成功条件を追加</button></fieldset></section> : <p className="fixed-note">達成すべき状態・判断理由・成功条件は作成時に固定されており、編集できるのはタイトルと仮説だけです。</p>}
    <div className="form-actions"><Link to={cancelTo} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div></form></main></Shell>;
};

const OutcomeCreatePage = () => { const { projectId = "", intentId = "" } = useParams(); return <OutcomeForm projectId={projectId} intentId={intentId} mode="create" initial={emptyOutcomeFormValues} heading={{ eyebrow: "New outcome", title: "Outcomeを登録", lede: "Strategist（またはHuman）の判断結果として、Intentへ近づくためのOutcomeと成功条件を登録します。Researchは必須ではありません。" }} submitLabel="Outcomeを登録" pendingLabel="登録中..." cancelTo={intentPath(projectId, intentId)} save={async (values) => (await request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes`, jsonPost(values))).outcome} />; };

/** サーバーのNOT_FOUNDメッセージ（先頭語がProject / Intent / Outcomeで異なる）から、どれが存在しないかを区別する。 */
const outcomeLoadFailure = (reason: unknown) => reason instanceof ApiError && reason.status === 404 ? (reason.message.startsWith("Outcome") ? "Outcomeが見つかりません。" : reason.message.startsWith("Intent") ? "Intentが見つかりません。" : "Projectが見つかりません。") : loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。");
const useOutcomePage = (projectId: string, intentId: string, outcomeId: string) => {
  const [state, setState] = useState<{ outcome: Outcome | null; error: string | null }>({ outcome: null, error: null });
  useEffect(() => { request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcomeId}`).then(({ outcome }) => setState({ outcome, error: null })).catch((reason: unknown) => setState({ outcome: null, error: outcomeLoadFailure(reason) })); }, [projectId, intentId, outcomeId]);
  return { ...state, setOutcome: (outcome: Outcome) => setState({ outcome, error: null }) };
};

const OutcomeEditPage = () => {
  const { projectId = "", intentId = "", outcomeId = "" } = useParams(); const { outcome, error } = useOutcomePage(projectId, intentId, outcomeId); const back = outcomePath(projectId, intentId, outcomeId);
  if (error) return <Shell><main className="narrow"><Link to={intentPath(projectId, intentId)} className="back-link">← Intent詳細</Link><ErrorState message={error} /></main></Shell>;
  if (!outcome) return <Shell><main className="narrow"><Loading /></main></Shell>;
  if (outcome.status !== "active") return <Shell><main className="narrow"><Link to={back} className="back-link">← Outcome詳細</Link><ErrorState message={`${outcomeStatusLabels[outcome.status]}のOutcomeは編集できません。`} /></main></Shell>;
  return <OutcomeForm projectId={projectId} intentId={intentId} mode="edit" initial={formValuesFromOutcome(outcome)} heading={{ eyebrow: "Edit outcome", title: "Outcomeを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={back} save={async (values) => (await request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcomeId}`, jsonInit("PATCH", { title: values.title, hypothesis: values.hypothesis }))).outcome} />;
};

const OutcomeDetailPage = () => {
  const { projectId = "", intentId = "", outcomeId = "" } = useParams(); const { outcome, error, setOutcome } = useOutcomePage(projectId, intentId, outcomeId);
  const [confirming, setConfirming] = useState(false); const [reason, setReason] = useState(""); const [isCancelling, setIsCancelling] = useState(false); const [cancelError, setCancelError] = useState<string | null>(null);
  const cancel = async (event: FormEvent) => { event.preventDefault(); setCancelError(null); setIsCancelling(true); try { setOutcome((await request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcomeId}/cancel`, jsonPost({ reason }))).outcome); setConfirming(false); } catch (failure) { const classified = classifyError(failure); setCancelError(classified.kind === "validation" ? classified.issues.map((issue) => `取消の理由: ${issue.message}`).join(" / ") : classified.kind === "not_found" ? "Outcomeが見つかりません。" : classified.message); } finally { setIsCancelling(false); } };
  return <Shell><main className="narrow"><Link to={intentPath(projectId, intentId)} className="back-link">← Intent詳細</Link>{error ? <ErrorState message={error} /> : !outcome ? <Loading /> : <>
    <div className="detail-hero"><p className="eyebrow">Outcome</p><h1>{outcome.title}</h1><p><span className={`status-badge${outcome.status === "active" ? "" : " muted"}`}>{outcomeStatusLabels[outcome.status]}</span></p><time>{new Date(outcome.updatedAt).toLocaleString("ja-JP")} 更新</time></div>
    <section className="detail-section"><dl className="intent-facts"><dt>達成すべき状態</dt><dd>{outcome.description}</dd><dt>仮説</dt><dd>{outcome.hypothesis ?? <span className="unset">未設定</span>}</dd><dt>判断理由（Strategistの判断）</dt><dd>{outcome.rationale}</dd></dl></section>
    <section className="detail-section" aria-labelledby="criteria-heading"><h2 id="criteria-heading">成功条件</h2><p className="section-note">成功条件は作成時に固定されます。変更する場合は、このOutcomeを取り消して新しいOutcomeを作成します。</p><ol className="criteria-list">{outcome.successCriteria.map((criterion) => <li key={criterion.id}><p className="criterion-title">{criterion.description}</p><dl><dt>測定方法</dt><dd>{criterion.measurement}</dd>{criterion.target && <><dt>目標値</dt><dd>{criterion.target}</dd></>}</dl></li>)}</ol></section>
    {outcome.status === "cancelled" && <section className="detail-section"><h2>取消</h2><p>{outcome.cancelReason}</p><p className="section-note">取り消したOutcomeはActiveに戻せません。続ける場合は新しいOutcomeを登録してください。</p></section>}
    {outcome.status === "active" && <div className="action-row"><Link to={outcomePath(projectId, intentId, outcome.id, "/edit")} className="button">タイトル・仮説を編集</Link><button type="button" className="secondary-button danger" aria-expanded={confirming} onClick={() => setConfirming(true)}>Outcomeを取消</button></div>}
    {outcome.status === "active" && confirming && <form className="abandon-panel" onSubmit={cancel}><h2>このOutcomeを取り消しますか？</h2><p>取り消すと編集できず、Activeに戻せません。成功条件を変えたい場合は、新しいOutcomeを登録してやり直せます。</p><label>取消の理由 <span>必須</span><textarea autoFocus required aria-required="true" maxLength={2000} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} /></label>{cancelError && <div className="state-card error" role="alert">{cancelError}</div>}<div className="form-actions"><button type="button" className="secondary-button" onClick={() => { setConfirming(false); setCancelError(null); }}>やめる</button><button className="button danger" disabled={isCancelling}>{isCancelling ? "取消中..." : "取り消す"}</button></div></form>}
  </>}</main></Shell>;
};

const App = () => <Routes><Route path="/" element={<ProjectListPage />} /><Route path="/projects/new" element={<ProjectCreatePage />} /><Route path="/projects/:projectId" element={<ProjectDetailPage />} /><Route path="/projects/:projectId/edit" element={<ProjectEditPage />} /><Route path="/projects/:projectId/intents/new" element={<IntentCreatePage />} /><Route path="/projects/:projectId/intents/:intentId" element={<IntentDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/edit" element={<IntentEditPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/new" element={<OutcomeCreatePage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId" element={<OutcomeDetailPage />} /><Route path="/projects/:projectId/intents/:intentId/outcomes/:outcomeId/edit" element={<OutcomeEditPage />} /></Routes>;
createRoot(document.getElementById("root")!).render(<StrictMode><BrowserRouter><App /></BrowserRouter></StrictMode>);
