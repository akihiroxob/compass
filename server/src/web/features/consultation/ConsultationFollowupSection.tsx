import { Link } from "react-router-dom";
import { projectViewPath, taskPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { formatTime } from "../execution";
import {
  describeActor,
  describeReflection,
  followupKindLabels,
  reflectionStatusLabels,
  reflectionStatusTones,
  taskStatusLabels,
  taskStatusTones,
  waitPhaseLabels,
  waitStateLabels,
  type ConsultationDetail,
  type ConsultationFollowupView,
} from "./consultation";

/** 文書反映の1件。反映先・文書反映Task・受入済み成果物（Repositoryの正本へのlink）を出し、文書の本文は出さない。 */
const FollowupItem = ({ followup, showProject }: { followup: ConsultationFollowupView; showProject: boolean }) => (
  <li className="consultation-followup">
    <p className="consultation-message-head">
      <span className={statusBadgeClass(reflectionStatusTones[followup.status])}>{reflectionStatusLabels[followup.status]}</span>
      <span className="consultation-scope">{followupKindLabels[followup.kind]}</span>
      <strong>{followup.title}</strong>
    </p>
    <dl className="intent-facts">
      {showProject && <><dt>反映担当Project</dt><dd><Link to={projectViewPath(followup.projectId, "overview")}>{followup.project?.name ?? `Project ${followup.projectId.slice(0, 8)}`}</Link></dd></>}
      <dt>反映先</dt>
      <dd>{followup.repository ? <a href={followup.repository.url} target="_blank" rel="noreferrer">{followup.repository.name}<span className="visually-hidden">（Repositoryを新しいタブで開く）</span></a> : <code>登録が外れたRepository {followup.repositoryId}</code>}</dd>
      <dt>文書反映Task</dt>
      <dd><Link to={taskPath(followup.projectId, followup.taskId)}>{followup.task?.title ?? `Task ${followup.taskId.slice(0, 8)}`}</Link>（{describeReflection(followup)}）</dd>
      <dt>目的</dt>
      <dd className="pre-wrap">{followup.purpose}</dd>
      <dt>元Taskの再開</dt>
      <dd className="pre-wrap">{followup.resumptionDependency ? `この反映の後に再開します: ${followup.resumptionDependency}` : "結論の成立だけで再開できます（反映を待ちません）"}</dd>
      <dt>成果物</dt>
      <dd>
        {followup.artifacts.length ? (
          <ul className="consultation-refs">
            {followup.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <code>{artifact.path}</code> @ <code>{artifact.commitSha.slice(0, 12)}</code>
                {artifact.pullRequestUrl && <> ・ <a href={artifact.pullRequestUrl} target="_blank" rel="noreferrer">Pull Request<span className="visually-hidden">（新しいタブで開く）</span></a></>}
                <small> {describeActor(artifact.recordedBy)} ・ {formatTime(artifact.createdAt)}</small>
              </li>
            ))}
          </ul>
        ) : <span className="unset">受入済みの成果物はまだ登録されていません</span>}
      </dd>
      <dt>依頼</dt>
      <dd>{describeActor(followup.requestedBy)} ・ {formatTime(followup.createdAt)}</dd>
    </dl>
  </li>
);

/**
 * 結論からの文書反映（仕様・Policy・ADR）と、この相談を待つ元Task（Project相談だけ）。反映状況は相談の解決とは別で、
 * 文書反映Taskの状態と受入済み成果物の登録から決まる。Workspace相談では反映担当Projectも出す。未解決で待つTaskも無ければ何も出さない。
 */
export const ConsultationFollowupSection = ({ detail }: { detail: ConsultationDetail }) => {
  const { consultation, followups, waitingTasks, resolution } = detail;
  const { projectId } = consultation;
  if (!resolution && !waitingTasks.length) return null;
  return (
    <>
      {projectId !== null && waitingTasks.length > 0 && (
        <section className="detail-section" aria-labelledby="consultation-waiting-heading">
          <h2 id="consultation-waiting-heading">この相談を待つTask</h2>
          <ul className="consultation-refs">
            {waitingTasks.map((task) => (
              <li key={task.taskId}>
                <Link to={taskPath(projectId, task.taskId)}>{task.title}</Link>{" "}
                <span className={statusBadgeClass(taskStatusTones[task.status])}>{taskStatusLabels[task.status]}</span>{" "}
                <span className={statusBadgeClass(task.state === "resuming" ? "progress" : "waiting")}>{waitStateLabels[task.state]}</span>
                <small> {waitPhaseLabels[task.phase]}の段階を保持</small>
                {task.failureReason && <p role="status" className="section-note pre-wrap">{task.failureReason}</p>}
              </li>
            ))}
          </ul>
        </section>
      )}
      {resolution && (
        <section className="detail-section" aria-labelledby="consultation-followups-heading">
          <h2 id="consultation-followups-heading">文書への反映</h2>
          <p className="section-note">文書の本文はRepositoryが正本です。ここには反映を依頼したTaskと、受け入れた成果物の参照だけを表示します。</p>
          {followups.length ? (
            <ul className="consultation-followups">{followups.map((followup) => <FollowupItem key={followup.id} followup={followup} showProject={projectId === null} />)}</ul>
          ) : (
            <p className="unset">この結論から文書への反映は依頼されていません</p>
          )}
        </section>
      )}
    </>
  );
};
