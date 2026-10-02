import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import type { ResearchRequestDetail } from "../../researchForm";

export const useResearchRequestPage = (projectId: string, requestId: string) => {
  const [detail, setDetail] = useState<ResearchRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(null);
    request<{ detail: ResearchRequestDetail }>(`/api/projects/${projectId}/research-requests/${requestId}`)
      .then(({ detail }) => setDetail(detail))
      .catch((reason: unknown) =>
        setError(loadFailureMessage(classifyError(reason), "Research Requestが見つかりません。")),
      );
  }, [projectId, requestId]);
  return { detail, error };
};
