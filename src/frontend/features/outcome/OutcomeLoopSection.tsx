import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { directionDecisionTypeLabels, type DirectionDecision } from "../../directionDecisionForm";
import {
  evaluationResultLabels,
  evaluationsPath,
  executionPath,
  executionStateLabels,
  executionSummaryPath,
  formatTime,
  outcomeLoopStage,
  StoryList,
  verdictLabels,
  type ExecutionOverview,
  type OutcomeEvaluation,
  type OutcomeExecutionRecord,
} from "../execution";

type LoopData = {
  overview: ExecutionOverview;
  record: OutcomeExecutionRecord | null;
  evaluations: OutcomeEvaluation[];
  decisions: DirectionDecision[];
};

const EvidenceList = ({ record }: { record: OutcomeExecutionRecord }) =>
  record.evidence.length ? (
    <ul className="grant-list">
      {record.evidence.map((item) => (
        <li key={item.id}>
          <a href={item.uri} target="_blank" rel="noreferrer" className="evidence-uri">{item.uri}</a>
          <small>
            {item.kind}
            {item.versionHash && <> ・ <code>{item.versionHash.slice(0, 12)}</code></>} ・ 観測 {formatTime(item.observedAt)} ・ Change #{item.sourceChangeCursor}
          </small>
        </li>
      ))}
    </ul>
  ) : (
    <p className="unset">Evidence参照はまだ還流されていません（Evidence不足）</p>
  );

const EvaluationCard = ({ evaluation, decisions }: { evaluation: OutcomeEvaluation; decisions: DirectionDecision[] }) => {
  const evidenceById = new Map(evaluation.snapshot.evidence.map((item) => [item.id, item]));
  return (
    <article className="intent-card">
      <h4>
        <span className={`status-badge${evaluation.result === "achieved" ? "" : " muted"}`}>{evaluationResultLabels[evaluation.result]}</span>{" "}
        {formatTime(evaluation.createdAt)} の評価
      </h4>
      <p className="execution-meta">
        {evaluation.principalId} ・ runRef <code>{evaluation.runRef}</code> ・ 評価時のExecution {executionStateLabels[evaluation.snapshot.execution.state]}（相関ID <code>{evaluation.snapshot.execution.correlationId}</code>）
      </p>
      <ol className="criteria-list">
        {evaluation.criteria.map((criterion) => (
          <li key={criterion.criterionId}>
            <p className="criterion-title">
              <span className={`status-badge${criterion.verdict === "met" ? "" : " muted"}`}>{verdictLabels[criterion.verdict]}</span> {criterion.description}
            </p>
            <dl>
              <dt>根拠</dt>
              <dd>{criterion.rationale}</dd>
              <dt>Evidence</dt>
              <dd>
                {criterion.evidenceIds.length ? (
                  criterion.evidenceIds.map((id) => <span key={id} className="criterion-evidence">{evidenceById.get(id)?.uri ?? id}</span>)
                ) : (
                  <span className="unset">参照なし</span>
                )}
              </dd>
            </dl>
          </li>
        ))}
      </ol>
      <p className="section-label">このEvaluationを根拠にしたDirection Decision</p>
      {decisions.length ? (
        <ul className="grant-list">
          {decisions.map((decision) => (
            <li key={decision.id}>
              <span><span className="status-badge muted">{directionDecisionTypeLabels[decision.type]}</span> {decision.judgment}</span>
              <small>{decision.principalId} ・ {formatTime(decision.createdAt)}</small>
            </li>
          ))}
        </ul>
      ) : (
        <p className="unset">まだありません（Strategistの判断待ち）</p>
      )}
    </article>
  );
};

/**
 * Outcome詳細の閉ループ表示（Human向け読取専用、Task 45）。Execution（Story・Task）・還流したSummary / Evidence・
 * Evaluation・それを根拠にしたDirection Decisionを、それぞれ所有側のWeb APIから読む。ここからは何も変更しない。
 */
export const OutcomeLoopSection = ({ projectId, intentId, outcomeId }: { projectId: string; intentId: string; outcomeId: string }) => {
  const key = `${projectId}/${intentId}/${outcomeId}`;
  const [state, setState] = useState<{ key: string; data: LoopData | null; error: string | null } | null>(null);
  useEffect(() => {
    let current = true;
    Promise.all([
      request<ExecutionOverview>(executionPath(projectId, outcomeId)),
      request<{ record: OutcomeExecutionRecord | null }>(executionSummaryPath(projectId, outcomeId)),
      request<{ evaluations: OutcomeEvaluation[] }>(evaluationsPath(projectId, outcomeId)),
      request<{ decisions: DirectionDecision[] }>(`/api/projects/${projectId}/intents/${intentId}/decisions`),
    ])
      .then(([overview, { record }, { evaluations }, { decisions }]) => {
        if (current) setState({ key, data: { overview, record, evaluations, decisions }, error: null });
      })
      .catch((reason: unknown) => {
        if (current) setState({ key, data: null, error: loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。") });
      });
    return () => { current = false; };
  }, [key]);
  const settled = state?.key === key ? state : null;
  const data = settled?.data;
  const stage = data ? outcomeLoopStage({ storyCount: data.overview.stories.length, record: data.record, evaluations: data.evaluations }) : null;
  return (
    <section className="detail-section" aria-labelledby="loop-heading">
      <h2 id="loop-heading">Execution・評価</h2>
      <p className="section-note">
        このOutcomeを参照するExecutionの進捗、還流した結果とEvidence参照、成功条件ごとのEvaluation、評価後の判断です。
        登録はAgent・RuntimeがMCPから行い、この画面は参照専用です。Executionの受入はOutcomeの達成を意味しません。
      </p>
      {settled?.error ? (
        <ErrorState message={`Execution・評価の読み込みに失敗しました: ${settled.error}`} />
      ) : !data || !stage ? (
        <Loading />
      ) : (
        <>
          <p><span className={`status-badge${stage.stage === "evaluated" && stage.result === "achieved" ? "" : " muted"}`}>{stage.label}</span></p>
          <h3>Execution</h3>
          <StoryList overview={data.overview} empty="このOutcomeを参照するStoryはまだありません（Execution未接続）" />
          <h3>Executionの結果（還流）</h3>
          {data.record ? (
            <>
              <dl className="intent-facts">
                <dt>結果</dt>
                <dd>{executionStateLabels[data.record.summary.state]}</dd>
                <dt>相関ID</dt>
                <dd><code>{data.record.summary.correlationId}</code></dd>
                <dt>反映したChange</dt>
                <dd>#{data.record.summary.executionCursor}（Runtimeの報告 #{data.record.summary.observedCursor}）・ {data.record.summary.principalId} ・ {formatTime(data.record.summary.updatedAt)}</dd>
              </dl>
              <h4>Evidence参照</h4>
              <EvidenceList record={data.record} />
            </>
          ) : (
            <p className="unset">まだ還流されていません</p>
          )}
          <h3>Evaluation</h3>
          {data.evaluations.length ? (
            data.evaluations.map((evaluation) => (
              <EvaluationCard key={evaluation.id} evaluation={evaluation} decisions={data.decisions.filter((decision) => decision.evaluationId === evaluation.id)} />
            ))
          ) : (
            <p className="unset">未評価です</p>
          )}
        </>
      )}
    </section>
  );
};
