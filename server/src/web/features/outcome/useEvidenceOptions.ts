import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import { workspaceApiPath } from "../../paths";
import type { ResearchRequest, ResearchRequestDetail } from "../research";
import { evidenceOptionGroups, type EvidenceOptionGroup } from "./evidenceOptions";

/** WorkspaceのResearchを読み、課題の根拠の候補を返す。失敗は候補0件と区別してerrorで返す。 */
export const useEvidenceOptions = (workspaceId: string) => {
  const [state, setState] = useState<{ groups: EvidenceOptionGroup[] | null; error: string | null }>({ groups: null, error: null });
  useEffect(() => {
    let current = true;
    request<{ requests: ResearchRequest[] }>(workspaceApiPath(workspaceId, "/research-requests"))
      .then(({ requests }) => Promise.all(requests.map(({ id }) => request<{ detail: ResearchRequestDetail }>(workspaceApiPath(workspaceId, `/research-requests/${id}`)).then(({ detail }) => detail))))
      .then((details) => { if (current) setState({ groups: evidenceOptionGroups(details), error: null }); })
      .catch((reason: unknown) => { if (current) setState({ groups: null, error: loadFailureMessage(classifyError(reason), "Workspaceが見つかりません。") }); });
    return () => { current = false; };
  }, [workspaceId]);
  return state;
};
