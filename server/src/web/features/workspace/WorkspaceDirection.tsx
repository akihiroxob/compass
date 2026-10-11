import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { intentStatusLabels } from "../../intentForm";
import { outcomeStatusLabels, type Outcome } from "../../outcomeForm";
import { intentPath, outcomePath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { EvaluationCard, EvidenceList } from "../outcome";
import { IntentFacts } from "../intent/IntentFacts";
import { executionPath, executionStateLabels, formatTime, StoryList, verdictLabels, verdictTones, type ExecutionOverview, type OutcomeExecutionRecord } from "../execution";
import { contributionNote, latestCriterionVerdicts, noTargetNote, targetContributions, type TargetContribution } from "./direction";
import type { DirectionData, OutcomeDetailData, OverviewProject, Part } from "./directionData";
import { buildOutcomeExecution, evaluationStage, pickOpenProject } from "./overview";
import { openProjects, ProjectName, stageLabels, TargetRow, WorkCounts } from "./WorkspaceOverview";
import { workspaceOutcomePath, workspacePath } from "./workspace";

const outcomeTone = (outcome: Pick<Outcome, "status">) => (outcome.status === "active" ? "progress" : "muted");

/**
 * 方向のIntent・Outcome。Active Intent → Active Outcome → Target Project別のWorkを並べ、各OutcomeはWorkspaceのOutcome詳細へ辿る。
 * Targetが無いActive OutcomeはStrategistの判断待ちとして出す。Taskの件数は状態だけで、Outcomeの達成を示さない。
 */
export const DirectionIntents = ({ workspaceId, direction, projects }: { workspaceId: string; direction: DirectionData; projects: Part<OverviewProject[]> }) => (
  <>
    {direction.activeIntent ? (
      <article className="intent-card">
        <span className={statusBadgeClass("progress")}>{intentStatusLabels.active}</span>
        <h3>{direction.activeIntent.title}</h3>
        <IntentFacts intent={direction.activeIntent} />
        <p className="section-label">Active Outcome（{direction.outcomes.length}件）</p>
        {direction.outcomes.length === 0 ? <p className="unset">ActiveなOutcomeはありません。Strategist（またはHuman）がIntentから観測可能なOutcomeを登録します。</p> : (
          <ul className="outcome-positions">
            {direction.outcomes.map((position) => {
              const stage = position.execution ? stageLabels[evaluationStage(position.execution)] : null;
              return (
                <li key={position.outcome.id}>
                  <div className="outcome-position-head">
                    <Link to={workspaceOutcomePath(workspaceId, position.outcome.intentId, position.outcome.id)}>{position.outcome.title}</Link>
                    {stage ? <span className={statusBadgeClass(stage.tone)}>{stage.label}</span> : <span className="status-badge muted">還流・評価の状態を確認できません</span>}
                  </div>
                  <p className="section-note">{position.detail.description}</p>
                  <p className="section-label">Target Project</p>
                  {position.targets === null ? <p role="alert" className="error-title">Target Projectを確認できません。</p> : position.targets.length === 0 ? <p className="unset">{noTargetNote(position.detail.status)}</p> : (
                    <ul className="target-works">{position.targets.map((target) => <TargetRow key={target.projectId} target={target} projects={projects} />)}</ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {direction.otherOutcomes.length > 0 && (
          <details className="past-intents">
            <summary>取消済み・評価済みなどのOutcome（{direction.otherOutcomes.length}件）</summary>
            <ul>{direction.otherOutcomes.map((outcome) => <li key={outcome.id} className="plain-item"><span className={statusBadgeClass(outcomeTone(outcome))}>{outcomeStatusLabels[outcome.status]}</span> <Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link></li>)}</ul>
          </details>
        )}
        {direction.outcomes.length > 0 && <p className="section-note">Taskの件数は状態だけを数えたもので、Agentの稼働やOutcomeの達成を示しません。達成はEvidenceにもとづくEvaluationで判断します。</p>}
      </article>
    ) : <p className="unset">ActiveなIntentはありません。</p>}
    {direction.pastIntents.length > 0 && <details className="past-intents"><summary>過去のIntent（{direction.pastIntents.length}件）</summary><ul>{direction.pastIntents.map((intent) => <li key={intent.id} className="plain-item"><span className="status-badge muted">{intentStatusLabels[intent.status]}</span> {intent.title}</li>)}</ul></details>}
  </>
);

/** Target ProjectのStory・Task。Project Membershipで開けるProjectだけ、そのProjectのExecution閲覧から読む。 */
const TargetStories = ({ projectId, outcomeId, canOpen }: { projectId: string; outcomeId: string; canOpen: boolean }) => {
  const key = `${projectId}/${outcomeId}`;
  const [state, setState] = useState<{ key: string; overview: ExecutionOverview | null; error: string | null } | null>(null);
  useEffect(() => {
    if (!canOpen) return;
    let current = true;
    request<ExecutionOverview>(executionPath(projectId, outcomeId))
      .then((overview) => { if (current) setState({ key, overview, error: null }); })
      .catch((reason: unknown) => { if (current) setState({ key, overview: null, error: loadFailureMessage(classifyError(reason), "Projectが見つからないか、閲覧する権限がありません。") }); });
    return () => { current = false; };
  }, [key, canOpen]);
  if (!canOpen) return <p className="locked-note">Project Membershipが無いため、Story・Taskは開けません。Projectのownerに招待を依頼してください。</p>;
  const settled = state?.key === key ? state : null;
  if (settled?.error) return <ErrorState message={`Story・Taskの読み込みに失敗しました: ${settled.error}`} />;
  if (!settled?.overview) return <Loading />;
  return <StoryList overview={settled.overview} empty="このOutcomeを参照するStoryはまだありません" />;
};

/** Target Project 1件の貢献: Work（Story・Task）→ 還流した結果とEvidence。 */
const ContributionCard = ({ contribution, outcomeId, projects }: { contribution: TargetContribution<OutcomeExecutionRecord>; outcomeId: string; projects: Part<OverviewProject[]> }) => {
  const project = projects.ok ? projects.value.find((item) => item.project.id === contribution.projectId) : undefined;
  return (
    <article className="intent-card direction-contribution" id={`target-${contribution.projectId}`}>
      <h3><ProjectName projectId={contribution.projectId} projects={projects} view="work" />{contribution.projectStatus === "archived" && <> <span className="status-badge muted">アーカイブ済み</span></>}</h3>
      <p className="section-note">{contributionNote(contribution)}</p>
      {contribution.work !== null && (
        <>
          <h4>Story・Task</h4>
          {contribution.work && <p className="execution-meta"><WorkCounts work={contribution.work} /></p>}
          <TargetStories projectId={contribution.projectId} outcomeId={outcomeId} canOpen={project?.canOpen ?? false} />
        </>
      )}
      <h4>結果とEvidence（還流）</h4>
      {contribution.record ? (
        <>
          <p className="execution-meta">{executionStateLabels[contribution.record.summary.state]} ・ 相関ID <code>{contribution.record.summary.correlationId}</code> ・ Change #{contribution.record.summary.executionCursor} ・ {formatTime(contribution.record.summary.updatedAt)}</p>
          <EvidenceList record={contribution.record} />
        </>
      ) : <p className="unset">まだ還流されていません</p>}
    </article>
  );
};

/**
 * WorkspaceのOutcome詳細（読取専用）。Outcome → 成功条件と最新の判定 → Target Project別の貢献（Story・Task・Evidence）→ Evaluationと
 * それを根拠にしたDirection Decision。Outcomeの編集・取消、Research・Direction Decisionの操作は既存のProject配下の画面で行い、
 * `canEdit`（WorkspaceのDirectionを変更できるか）は導線の表示だけを決める。拒否は常にserverが行う。
 */
export const WorkspaceOutcomeDetail = ({ workspaceId, data, projects, canEdit }: { workspaceId: string; data: OutcomeDetailData; projects: Part<OverviewProject[]>; canEdit: boolean }) => {
  const { outcome, executions, evaluations, decisions } = data;
  const contributions = executions.ok ? targetContributions(executions.value.targets, data.targetWork, executions.value.evaluability) : null;
  const verdicts = latestCriterionVerdicts(evaluations.ok ? evaluations.value : []);
  const decided = decisions.ok ? new Set(decisions.value.flatMap(({ evaluationId }) => (evaluationId ? [evaluationId] : []))) : null;
  const execution = executions.ok && evaluations.ok ? buildOutcomeExecution(executions.value, evaluations.value, decided) : null;
  const stage = execution && outcome.status === "active" ? stageLabels[evaluationStage(execution)] : null;
  const openProject = pickOpenProject(executions.ok ? executions.value.targets.map(({ projectId }) => projectId) : [], openProjects(projects));
  const projectLabel = (projectId: string) => <ProjectName projectId={projectId} projects={projects} view="work" />;
  return (
    <>
      <Link to={workspacePath(workspaceId, "direction")} className="back-link">← 方向</Link>
      <section className="detail-section" aria-labelledby="outcome-position-heading">
        <p className="eyebrow">Outcome</p>
        <h2 id="outcome-position-heading">{outcome.title}</h2>
        <p><span className={statusBadgeClass(outcomeTone(outcome))}>{outcomeStatusLabels[outcome.status]}</span>{stage && <> <span className={statusBadgeClass(stage.tone)}>{stage.label}</span></>}</p>
        <dl className="intent-facts"><dt>達成すべき状態</dt><dd>{outcome.description}</dd><dt>仮説</dt><dd>{outcome.hypothesis ?? <span className="unset">未設定</span>}</dd><dt>判断理由（Strategistの判断）</dt><dd>{outcome.rationale}</dd></dl>
        {outcome.status === "cancelled" && <><h3>取消の理由</h3><p>{outcome.cancelReason}</p></>}
        {openProject ? (
          <div className="action-row">
            <Link to={intentPath(openProject, outcome.intentId)} className="secondary-button compact">Intent詳細（Research・Direction Decision）</Link>
            {canEdit && outcome.status === "active" && <Link to={outcomePath(openProject, outcome.intentId, outcome.id)} className="secondary-button compact">Outcomeの編集・取消</Link>}
          </div>
        ) : <p className="locked-note">Intentの詳細（Research・Direction Decision）とOutcomeの編集はProjectの画面から開きます。開けるProjectがありません。</p>}
      </section>
      <section className="detail-section" aria-labelledby="workspace-criteria-heading">
        <h2 id="workspace-criteria-heading">成功条件</h2>
        <p className="section-note">判定は最新のEvaluationの結果です。根拠とEvidenceは下の「Evaluation」で確認します。</p>
        {!evaluations.ok && <ErrorState message={`Evaluationの読み込みに失敗しました: ${evaluations.error}`} />}
        <ol className="criteria-list">
          {outcome.successCriteria.map((criterion) => {
            const verdict = verdicts.get(criterion.id);
            return (
              <li key={criterion.id}>
                <p className="criterion-title">{verdict ? <span className={statusBadgeClass(verdictTones[verdict.verdict])}>{verdictLabels[verdict.verdict]}</span> : evaluations.ok && <span className="status-badge muted">未評価</span>} {criterion.description}</p>
                <dl><dt>測定方法</dt><dd>{criterion.measurement}</dd>{criterion.target && <><dt>目標値</dt><dd>{criterion.target}</dd></>}{verdict && <><dt>根拠</dt><dd>{verdict.rationale}</dd></>}</dl>
              </li>
            );
          })}
        </ol>
      </section>
      <section className="detail-section" aria-labelledby="target-works-heading">
        <h2 id="target-works-heading">Target Projectごとの貢献</h2>
        <p className="section-note">Story・TaskはTarget Projectに属し、このOutcomeへ貢献します。Taskの受入はOutcomeの達成を意味しません。</p>
        {!executions.ok ? <ErrorState message={`Target Projectの読み込みに失敗しました: ${executions.error}`} /> : contributions!.length === 0 ? <p className="unset">{noTargetNote(outcome.status)}</p> : (
          <>
            {data.targetWork === null && <p role="alert" className="error-title">Target別のWorkの要約を取得できません。</p>}
            {contributions!.map((contribution) => <ContributionCard key={contribution.projectId} contribution={contribution} outcomeId={outcome.id} projects={projects} />)}
          </>
        )}
        {executions.ok && executions.value.nonTargetExecutions.length > 0 && <p className="section-note">Targetから外れたProjectの還流 {executions.value.nonTargetExecutions.length}件は、評価の入力に含めません。</p>}
      </section>
      <section className="detail-section" aria-labelledby="workspace-evaluation-heading">
        <h2 id="workspace-evaluation-heading">Evaluation</h2>
        <p className="section-note">EvaluatorがTarget Projectの還流とEvidenceから成功条件ごとに評価した記録と、それを根拠にしたStrategistの判断です。</p>
        {!evaluations.ok ? <ErrorState message={`Evaluationの読み込みに失敗しました: ${evaluations.error}`} /> : !decisions.ok ? <ErrorState message={`Direction Decisionの読み込みに失敗しました: ${decisions.error}`} /> : evaluations.value.length === 0 ? <p className="unset">未評価です</p> : (
          evaluations.value.map((evaluation) => <EvaluationCard key={evaluation.id} evaluation={evaluation} decisions={decisions.value.filter((decision) => decision.evaluationId === evaluation.id)} projectLabel={projectLabel} />)
        )}
      </section>
    </>
  );
};
