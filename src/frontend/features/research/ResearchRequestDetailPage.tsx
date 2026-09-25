import { Link, useParams } from "react-router-dom";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { intentPath } from "../../paths";
import {
  researchRequestKindLabels,
  researchRequestStatusLabels,
  type ResearchFinding,
  type ResearchResult,
  type ResearchSynthesis,
} from "../../researchForm";
import { useResearchRequestPage } from "./useResearchRequestPage";

const FindingItem = ({ finding }: { finding: ResearchFinding }) => (
  <li>
    <p>{finding.statement}</p>
    <small>
      確信度 {finding.confidence} ・ 観測 {new Date(finding.observedAt).toLocaleString("ja-JP")}
      {finding.expiresAt !== null && ` ・ 期限 ${new Date(finding.expiresAt).toLocaleString("ja-JP")}`}
    </small>
    {finding.conflictsWithFindingIds.length > 0 && (
      <p className="section-note">競合Finding: {finding.conflictsWithFindingIds.join(", ")}</p>
    )}
  </li>
);

const ResultCard = ({ result }: { result: ResearchResult }) => (
  <article className="intent-card">
    <h3>Result #{result.sequence}</h3>
    <p>{result.summary}</p>
    <dl className="intent-facts">
      <dt>Evidence参照</dt>
      <dd>
        {result.evidenceRefs.length ? (
          <ul>
            {result.evidenceRefs.map((evidence) => (
              <li key={evidence.id}>
                {evidence.kind}: {evidence.uri}
              </li>
            ))}
          </ul>
        ) : (
          <span className="unset">なし</span>
        )}
      </dd>
      <dt>Finding</dt>
      <dd>
        {result.findings.length ? (
          <ul>{result.findings.map((finding) => <FindingItem key={finding.id} finding={finding} />)}</ul>
        ) : (
          <span className="unset">なし</span>
        )}
      </dd>
    </dl>
    <small>{new Date(result.createdAt).toLocaleString("ja-JP")} 登録（{result.principalId}）</small>
  </article>
);

const SynthesisCard = ({ synthesis }: { synthesis: ResearchSynthesis }) => (
  <article className="intent-card">
    <h3>
      Synthesis v{synthesis.version}
      {synthesis.supersedesId && <span className="status-badge muted">supersedes {synthesis.supersedesId}</span>}
    </h3>
    <p>{synthesis.conclusion}</p>
    <small>
      有効時点 {new Date(synthesis.validAsOf).toLocaleString("ja-JP")} ・ Finding {synthesis.findingIds.length}件
    </small>
  </article>
);

export const ResearchRequestDetailPage = () => {
  const { projectId = "", requestId = "" } = useParams();
  const { detail, error } = useResearchRequestPage(projectId, requestId);
  return (
    <Shell>
      <main className="narrow">
        <Link to={`/projects/${projectId}`} className="back-link">
          ← Project詳細
        </Link>
        {error ? (
          <ErrorState message={error} />
        ) : !detail ? (
          <Loading />
        ) : (
          <>
            <div className="detail-hero">
              <p className="eyebrow">Research Request</p>
              <h1>{detail.request.question}</h1>
              <p>
                <span className="status-badge">{researchRequestStatusLabels[detail.request.status]}</span>{" "}
                <span className="status-badge muted">{researchRequestKindLabels[detail.request.kind]}</span>
              </p>
              <time>{new Date(detail.request.updatedAt).toLocaleString("ja-JP")} 更新</time>
            </div>
            <section className="detail-section">
              <dl className="intent-facts">
                <dt>Scope</dt>
                <dd>{detail.request.scope}</dd>
                <dt>完了条件</dt>
                <dd>{detail.request.completionCondition}</dd>
                <dt>予算</dt>
                <dd>
                  {detail.request.budgetUsed} / {detail.request.budgetTotal}
                </dd>
                <dt>発端Intent</dt>
                <dd>
                  {detail.request.originIntentId ? (
                    <Link to={intentPath(projectId, detail.request.originIntentId)}>{detail.request.originIntentId}</Link>
                  ) : (
                    <span className="unset">なし（Project Watch）</span>
                  )}
                </dd>
                {detail.request.stopReason && (
                  <>
                    <dt>停止理由</dt>
                    <dd>{detail.request.stopReason}</dd>
                  </>
                )}
              </dl>
            </section>
            <section className="detail-section" aria-labelledby="results-heading">
              <h2 id="results-heading">Result</h2>
              {detail.results.length ? (
                detail.results.map((result) => <ResultCard key={result.id} result={result} />)
              ) : (
                <p className="unset">Resultは未登録です</p>
              )}
            </section>
            <section className="detail-section" aria-labelledby="syntheses-heading">
              <h2 id="syntheses-heading">Synthesis</h2>
              {detail.syntheses.length ? (
                detail.syntheses.map((synthesis) => <SynthesisCard key={synthesis.id} synthesis={synthesis} />)
              ) : (
                <p className="unset">Synthesisは未登録です</p>
              )}
            </section>
          </>
        )}
      </main>
    </Shell>
  );
};
