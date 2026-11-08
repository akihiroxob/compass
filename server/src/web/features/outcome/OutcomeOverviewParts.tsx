import { Link } from "react-router-dom";
import { statusBadgeClass } from "../../statusTone";
import { consultationDestination } from "./outcomeOverviewLinks";
import { problemKindLabels, progressPercent, progressText, type OutcomeOverview, type OutcomeDelivery, type OutcomeEffect, type OutcomeProblemFact, type OutcomeProblemSummary, type TaskProgress } from "./outcomeOverview";

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

const effectLabels = { achieved: "達成", failed: "未達", insufficient_evidence: "根拠不足" } as const;
const effectTones = { achieved: "done", failed: "attention", insufficient_evidence: "warning" } as const;

const DeliveryView = ({ delivery }: { delivery: OutcomeDelivery }) => {
  if (delivery.state === "unknown") return <><span className={statusBadgeClass("warning")}>未取得</span> 公開の確認を取得できていません</>;
  if (delivery.state === "no_changes") return <><span className={statusBadgeClass("muted")}>対象なし</span> 公開を確認する変更がありません</>;
  return (
    <>
      <span className={statusBadgeClass(delivery.published === delivery.changeCount ? "done" : "muted")}>
        公開済み {delivery.published}/{delivery.changeCount}件
      </span>
      {" "}
      未公開 {delivery.notPublished}件・確認できず {delivery.unconfirmed}件
      {delivery.notConfigured > 0 && <>（うち公開確認の入力元が未設定 {delivery.notConfigured}件）</>}
    </>
  );
};


/**
 * 提供状況（公開）と効果（Evaluation）の確認状況。Task進捗とは別の事実で、一覧と詳細が同じ値を示す。
 * 提供状況はWorkの公開記録から数えた変更ごとの公開状況で、Outcome全体の提供済みは判断しない。
 * 取得できない・確認できない・評価が無いときも成功や達成に見せない。
 */
export const ConfirmationView = ({ delivery, effect }: { delivery: OutcomeDelivery; effect: OutcomeEffect }) => (
  <dl className="outcome-confirmation">
    <div><dt>提供状況</dt><dd><DeliveryView delivery={delivery} /></dd></div>
    <div><dt>効果</dt><dd>
      {effect.state === "not_evaluated" && <><span className={statusBadgeClass("muted")}>未評価</span> Evaluationがありません</>}
      {effect.state === "unknown" && <><span className={statusBadgeClass("warning")}>未取得</span> 評価を取得できていません</>}
      {effect.state === "evaluated" && <><span className={statusBadgeClass(effectTones[effect.result])}>{effectLabels[effect.result]}</span> 最新のEvaluation（{new Date(effect.evaluatedAt).toLocaleDateString("ja-JP")}）</>}
    </dd></div>
  </dl>
);
