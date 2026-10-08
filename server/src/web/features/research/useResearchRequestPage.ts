import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import { workspaceApiPath } from "../../paths";
import type { ResearchRequestDetail } from "../../researchForm";
import { useProjectWorkspaceDirection } from "../../useWorkspaceDirection";

/** Project画面から、所属WorkspaceのResearch Requestを読む。 */
export const useResearchRequestPage = (projectId: string, requestId: string) => {
  const direction = useProjectWorkspaceDirection(projectId);
  const { workspaceId } = direction;
  const [detail, setDetail] = useState<ResearchRequestDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setDetail(null);
    setError(null);
    if (workspaceId === null) return;
    request<{ detail: ResearchRequestDetail }>(workspaceApiPath(workspaceId, `/research-requests/${requestId}`))
      .then(({ detail }) => setDetail(detail))
      .catch((reason: unknown) =>
        setError(loadFailureMessage(classifyError(reason), "Research Requestが見つかりません。")),
      );
  }, [workspaceId, requestId]);
  return { detail, error: direction.access === "error" ? direction.message : error };
};
