import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { researchRequestPath } from "../../paths";
import {
  researchRequestKindLabels,
  researchRequestStatusLabels,
  type ResearchRequest,
  type ResearchRequestStatus,
} from "../../researchForm";

const closedStatuses: ResearchRequestStatus[] = ["completed", "insufficient", "not_needed", "cancelled"];

const RequestRow = ({ request: item }: { request: ResearchRequest }) => (
  <li>
    <Link to={researchRequestPath(item.projectId, item.id)}>
      <span className={`status-badge${closedStatuses.includes(item.status) ? " muted" : ""}`}>
        {researchRequestStatusLabels[item.status]}
      </span>{" "}
      {item.question}
      <small>
        {researchRequestKindLabels[item.kind]} ・ 予算 {item.budgetUsed}/{item.budgetTotal}
      </small>
    </Link>
  </li>
);

/**
 * ProjectのResearch Request一覧（Human向け読み取り専用）。RequesterはResearcher・Compass application層で、
 * この画面から作成・登録は行わない。詳細（Result → Finding / Evidence、Synthesis）は個別画面で辿る。
 */
export const ResearchSection = ({ projectId }: { projectId: string }) => {
  const [requests, setRequests] = useState<ResearchRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<{ requests: ResearchRequest[] }>(`/api/projects/${projectId}/research-requests`)
      .then(({ requests }) => setRequests(requests))
      .catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")));
  }, [projectId]);
  return (
    <section className="detail-section" aria-labelledby="research-heading">
      <h2 id="research-heading">Research</h2>
      <p className="section-note">
        Researcherが蓄積したResult・Finding・Synthesisの来歴です。ResearcherはMCPから登録し、この画面は参照専用です。
      </p>
      {error ? (
        <ErrorState message={`Researchの読み込みに失敗しました: ${error}`} />
      ) : requests === null ? (
        <Loading />
      ) : requests.length ? (
        <ul className="grant-list">
          {requests.map((item) => <RequestRow key={item.id} request={item} />)}
        </ul>
      ) : (
        <p className="unset">Research Requestは未登録です</p>
      )}
    </section>
  );
};
