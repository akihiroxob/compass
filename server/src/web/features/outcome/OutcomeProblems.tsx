import { Link } from "react-router-dom";
import { statusBadgeClass } from "../../statusTone";
import { problemEvidenceKindLabels, problemEvidenceStatusLabels, type OutcomeProblem, type ProblemEvidenceStatus } from "./outcome";
import type { StatusTone } from "../../statusTone";

const evidenceStatusTones: Record<ProblemEvidenceStatus, StatusTone> = { insufficient: "waiting", observed: "muted", refuted: "muted" };

/**
 * 「解決したい課題」。課題ごとに根拠の状態・観測した事実・原因の仮説・解決策の仮説・根拠参照を全文で並べる。
 * 観測と原因の仮説は別の項目で表示し、原因を確定として表示しない。Taskの停止などの開発上の障害はここに混ぜない。
 * `evidenceTo`はResearchの依頼を開く画面（開けない場合はnull）。
 */
export const OutcomeProblems = ({ problems, evidenceTo }: { problems: readonly OutcomeProblem[]; evidenceTo: (requestId: string) => string | null }) => (
  <section className="detail-section" aria-labelledby="outcome-problems-heading">
    <h2 id="outcome-problems-heading">解決したい課題</h2>
    {problems.length === 0 ? <p className="unset">課題はまだ記録されていません。</p> : (
      <ol className="problem-list">
        {problems.map((problem, index) => (
          <li key={problem.id}>
            <h3 className="criterion-title"><span className={statusBadgeClass(evidenceStatusTones[problem.evidenceStatus])}>{problemEvidenceStatusLabels[problem.evidenceStatus]}</span> 課題 {index + 1}: {problem.statement}</h3>
            <dl>
              <dt>観測した事実</dt><dd>{problem.observation ?? <span className="unset">未観測</span>}</dd>
              <dt>原因の仮説（未確認）</dt><dd>{problem.causeHypothesis ?? <span className="unset">未設定</span>}</dd>
              <dt>解決策の仮説</dt><dd>{problem.solutionHypothesis ?? <span className="unset">未設定</span>}</dd>
              <dt>根拠</dt>
              <dd>{problem.evidence.length === 0 ? <span className="unset">根拠の関連付けはありません</span> : (
                <ul className="problem-evidence-list">
                  {problem.evidence.map((evidence) => {
                    const to = evidenceTo(evidence.requestId);
                    return (
                      <li key={`${evidence.kind}:${evidence.id}`}>
                        <span className="problem-evidence-kind">{problemEvidenceKindLabels[evidence.kind]}{evidence.superseded && "（新しい版あり）"}</span>
                        <span className="problem-evidence-summary">{evidence.summary}</span>
                        {to && <Link to={to} className="text-link">Researchを開く</Link>}
                      </li>
                    );
                  })}
                </ul>
              )}</dd>
            </dl>
          </li>
        ))}
      </ol>
    )}
  </section>
);
