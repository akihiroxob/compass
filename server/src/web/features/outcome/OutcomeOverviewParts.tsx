import { Link } from "react-router-dom";
import { statusBadgeClass } from "../../statusTone";
import { consultationDestination } from "./outcomeOverviewLinks";
import { problemKindLabels, progressPercent, progressText, type OutcomeOverview, type OutcomeProblemFact, type OutcomeProblemSummary, type TaskProgress } from "./outcomeOverview";

/**
 * Task進捗。受入済みを分子、取消を除いたTaskを分母とし、取消は別に示す。Outcomeの達成度や効果ではない。
 * 分母が0のときは割合を出さず、対象なし・未起票・Task0件を文言で区別する。
 */
export const TaskProgressView = ({ progress, detail = false }: { progress: TaskProgress; detail?: boolean }) => {
  const percent = progressPercent(progress);
  return (
    <div className="outcome-progress">
      <p className="outcome-progress-text">
        <strong>{progressText(progress)}</strong>
        {percent && <span className="outcome-progress-ratio"> {percent}</span>}
      </p>
      {progress.kind === "counted" && (
        <>
          <progress max={progress.denominator} value={progress.accepted} aria-label={`Task進捗 受入済み${progress.accepted}件、対象${progress.denominator}件`} />
          {progress.canceled > 0 && <p className="outcome-progress-note">取消 {progress.canceled}件（分母に含めず、総数 {progress.total}件）</p>}
        </>
      )}
      {detail && progress.kind === "counted" && (
        <p className="outcome-progress-note">未完了 {progress.denominator - progress.accepted}件（差戻し {progress.counts.rejected}件を含む）</p>
      )}
    </div>
  );
};

/** 代表の問題と「ほかN件」。取得できなかった場合は「未取得」とし、問題なしと区別する。 */
export const ProblemSummaryView = ({ problems }: { problems: OutcomeProblemSummary }) => {
  if (problems.state === "unknown") return <p className="outcome-problem unknown"><span className={statusBadgeClass("warning")}>未取得</span> 問題の情報を取得できていません。問題なしではありません。</p>;
  if (problems.state === "none") return <p className="outcome-problem"><span className={statusBadgeClass("muted")}>なし</span> 待っている相談はありません。</p>;
  const { representative } = problems;
  return (
    <p className="outcome-problem">
      <span className={statusBadgeClass(representative.kind === "waiting_human" ? "attention" : "waiting")}>{problemKindLabels[representative.kind]}</span>{" "}
      <span className="outcome-problem-reason">{representative.reason}</span>
      {problems.otherCount > 0 && <span className="outcome-problem-other"> ほか{problems.otherCount}件</span>}
    </p>
  );
};

/** 問題の全件。相談の詳細へ辿れる。 */
export const ProblemList = ({ workspaceId, problems }: { workspaceId: string; problems: OutcomeProblemFact[] }) => (
  <ul className="outcome-problem-list">
    {problems.map((problem) => (
      <li key={problem.consultationId}>
        <p><span className={statusBadgeClass(problem.kind === "waiting_human" ? "attention" : "waiting")}>{problemKindLabels[problem.kind]}</span>{" "}
          <Link to={consultationDestination(workspaceId, problem)}>{problem.title}</Link></p>
        <p className="outcome-problem-reason">{problem.reason}</p>
        {problem.taskIds.length > 0 && <p className="outcome-progress-note">待っているTask {problem.taskIds.length}件</p>}
      </li>
    ))}
  </ul>
);

export const overviewAriaLabel = (overview: OutcomeOverview) => `${overview.title}（${overview.intentTitle}）`;
