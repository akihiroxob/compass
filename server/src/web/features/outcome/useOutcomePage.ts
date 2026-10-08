import { useEffect, useState } from "react";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import type { Outcome } from "../../outcomeForm";
import { workspaceApiPath } from "../../paths";

/** サーバーのNOT_FOUNDメッセージ（先頭語がWorkspace / Intent / Outcomeで異なる）から、どれが存在しないかを区別する。 */
const outcomeLoadFailure = (reason: unknown) => reason instanceof ApiError && reason.status === 404 ? (reason.message.startsWith("Outcome") ? "Outcomeが見つかりません。" : reason.message.startsWith("Intent") ? "Intentが見つかりません。" : "Workspaceが見つかりません。") : loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。");

/** 所属WorkspaceのOutcomeを読む（`workspaceId`が判明するまでは読まない）。 */
export const useOutcomePage = (workspaceId: string | null, intentId: string, outcomeId: string) => {
  const [state, setState] = useState<{ outcome: Outcome | null; error: string | null }>({ outcome: null, error: null });
  useEffect(() => { if (workspaceId === null) return; request<{ outcome: Outcome }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcomes/${outcomeId}`)).then(({ outcome }) => setState({ outcome, error: null })).catch((reason: unknown) => setState({ outcome: null, error: outcomeLoadFailure(reason) })); }, [workspaceId, intentId, outcomeId]);
  return { ...state, setOutcome: (outcome: Outcome) => setState({ outcome, error: null }) };
};
