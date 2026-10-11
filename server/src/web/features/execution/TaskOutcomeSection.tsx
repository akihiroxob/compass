import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { Loading } from "../../components/StateCard";
import { workspaceApiPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { workspaceOutcomePath } from "../workspace/workspace";
import { EvidenceList } from "./EvidenceList";
import {
  evaluationResultLabels,
  evaluationResultTones,
  evaluationsPath,
  executionStateLabels,
  executionSummaryPath,
  findTaskOutcome,
  formatTime,
  loopStageTone,
  outcomeLoopStage,
  taskAcceptanceNote,
  taskStatusLabels,
  taskTone,
  type ExecutionStory,
  type ExecutionTask,
  type OutcomeEvaluation,
  type OutcomeExecutionRecord,
  type TaskOutcomeRef,
} from "./execution";

/** 部分ごとの取得結果。取得失敗を空（未還流・未評価）として表示しない。 */
type Part<T> = { ok: true; value: T } | { ok: false; error: string };
const settle = <T,>(promise: Promise<T>, notFound: string): Promise<Part<T>> =>
  promise.then(
    (value): Part<T> => ({ ok: true, value }),
    (reason: unknown): Part<T> => ({ ok: false, error: loadFailureMessage(classifyError(reason), notFound) }),
  );
const workspaceUnavailable = "所属Workspaceを閲覧する権限がないため表示できません（Workspace Membershipが必要です）。";

type OutcomeData = {
  record: Part<OutcomeExecutionRecord | null>;
  evaluations: Part<OutcomeEvaluation[]>;
  outcome: Part<TaskOutcomeRef | null>;
};

/**
 * Outcomeの所属Intentを探す。Workspace所有のOutcomeはIntent配下のWeb APIで読むため、Intentごとに一覧を読む
 * （WorkspaceのIntentは少数で、Active Intentは最大1件）。
 */
const loadOutcomeRef = async (workspaceId: string, outcomeId: string): Promise<TaskOutcomeRef | null> => {
  const { intents } = await request<{ intents: { id: string }[] }>(workspaceApiPath(workspaceId, "/intents"));
  const lists = await Promise.all(
    intents.map((intent) => request<{ outcomes: TaskOutcomeRef[] }>(workspaceApiPath(workspaceId, `/intents/${intent.id}/outcomes`)).then(({ outcomes }) => outcomes)),
  );
  return findTaskOutcome(lists, outcomeId);
};

/**
 * Task詳細の「Task受入とOutcome評価」。Taskの状態（Project Membershipで読むWork）と、StoryのOutcomeへ還流したこのProjectの
 * Execution・Evidence（Project Membership）、Outcomeの評価（Workspace Membership）を別々に読み、Taskの受入をOutcomeの達成として示さない。
 * Taskの更新時刻が変わったら（受入・差戻し等の後）読み直す。表示だけで、ここからは何も変更しない。
 */
export const TaskOutcomeSection = ({ projectId, workspaceId, task, story }: { projectId: string; workspaceId: string | null; task: ExecutionTask; story: ExecutionStory | null }) => {
  const outcomeId = story?.outcomeId ?? null;
  const key = `${projectId}/${workspaceId ?? ""}/${outcomeId ?? ""}/${task.updatedAt}`;
  const [state, setState] = useState<{ key: string; data: OutcomeData } | null>(null);
  useEffect(() => {
    if (outcomeId === null) return;
    let current = true;
    // 所属Workspaceを解決できない場合は、Workspace所有の評価・Outcomeを読まずに閲覧不可と示す。
    const fromWorkspace = <T,>(load: (id: string) => Promise<T>): Promise<Part<T>> =>
      workspaceId === null ? Promise.resolve({ ok: false, error: workspaceUnavailable }) : settle(load(workspaceId), workspaceUnavailable);
    Promise.all([
      settle(request<{ record: OutcomeExecutionRecord | null }>(executionSummaryPath(projectId, outcomeId)).then(({ record }) => record), "Outcomeが見つかりません。"),
      fromWorkspace((id) => request<{ evaluations: OutcomeEvaluation[] }>(evaluationsPath(id, outcomeId)).then(({ evaluations }) => evaluations)),
      fromWorkspace((id) => loadOutcomeRef(id, outcomeId)),
    ]).then(([record, evaluations, outcome]) => { if (current) setState({ key, data: { record, evaluations, outcome } }); });
    return () => { current = false; };
  }, [key]);
  const data = state?.key === key ? state.data : null;
  const stage = data?.record.ok && data.evaluations.ok ? outcomeLoopStage({ storyCount: 1, record: data.record.value, evaluations: data.evaluations.value }) : null;
  const outcome = data?.outcome.ok ? data.outcome.value : null;
  const latest = data?.evaluations.ok ? data.evaluations.value[0] ?? null : null;
  return (
    <section className="detail-section" aria-labelledby="task-outcome-heading">
      <h2 id="task-outcome-heading">Task受入とOutcome評価</h2>
      <p className="section-note">{taskAcceptanceNote(task, outcomeId !== null)}</p>
      <div className="detail-columns task-outcome-columns">
        <div>
          <p className="section-label">Task受入（Project）</p>
          <p><span className={statusBadgeClass(taskTone(task))}>{taskStatusLabels[task.status]}</span></p>
        </div>
        <div>
          <p className="section-label">Outcome評価（Workspace）</p>
          {outcomeId === null ? (
            <p className="unset">対象外（Outcomeを参照しないStory）</p>
          ) : !data ? (
            <Loading />
          ) : (
            <>
              {outcome && workspaceId ? (
                <p><Link to={workspaceOutcomePath(workspaceId, outcome.intentId, outcome.id)}>{outcome.title}</Link></p>
              ) : (
                <p>Outcome <code>{outcomeId}</code></p>
              )}
              {stage ? (
                <p><span className={statusBadgeClass(loopStageTone(stage))}>{stage.label}</span></p>
              ) : !data.evaluations.ok ? (
                <p role="alert" className="error-title">Outcome評価を読み込めませんでした: {data.evaluations.error}</p>
              ) : latest ? (
                <p><span className={statusBadgeClass(evaluationResultTones[latest.result])}>評価済み: {evaluationResultLabels[latest.result]}</span></p>
              ) : (
                <p className="unset">未評価</p>
              )}
              {latest && <p className="execution-meta">最新の評価 {formatTime(latest.createdAt)} ・ {latest.principalId}</p>}
            </>
          )}
        </div>
      </div>
      {outcomeId !== null && (
        <>
          <h3>Evidence（このProjectから還流）</h3>
          <p className="section-note">EvidenceはOutcomeとProjectの単位でRuntimeが還流する参照で、Task単位ではありません。TaskごとのPR・検証の記録はCommentを確認してください。</p>
          {!data ? (
            <Loading />
          ) : !data.record.ok ? (
            <p role="alert" className="error-title">Evidenceを読み込めませんでした: {data.record.error}</p>
          ) : data.record.value ? (
            <>
              <p className="execution-meta">
                {executionStateLabels[data.record.value.summary.state]} ・ Change #{data.record.value.summary.executionCursor} ・ {formatTime(data.record.value.summary.updatedAt)} 還流
              </p>
              <EvidenceList record={data.record.value} />
            </>
          ) : (
            <p className="unset">このProjectのExecutionの結果はまだOutcomeへ還流されていません。</p>
          )}
        </>
      )}
    </section>
  );
};
