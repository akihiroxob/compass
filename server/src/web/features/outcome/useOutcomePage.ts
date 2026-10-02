import { useEffect, useState } from "react";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import type { Outcome } from "../../outcomeForm";

/** サーバーのNOT_FOUNDメッセージ（先頭語がProject / Intent / Outcomeで異なる）から、どれが存在しないかを区別する。 */
const outcomeLoadFailure = (reason: unknown) => reason instanceof ApiError && reason.status === 404 ? (reason.message.startsWith("Outcome") ? "Outcomeが見つかりません。" : reason.message.startsWith("Intent") ? "Intentが見つかりません。" : "Projectが見つかりません。") : loadFailureMessage(classifyError(reason), "Outcomeが見つかりません。");

export const useOutcomePage = (projectId: string, intentId: string, outcomeId: string) => {
  const [state, setState] = useState<{ outcome: Outcome | null; error: string | null }>({ outcome: null, error: null });
  useEffect(() => { request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcomeId}`).then(({ outcome }) => setState({ outcome, error: null })).catch((reason: unknown) => setState({ outcome: null, error: outcomeLoadFailure(reason) })); }, [projectId, intentId, outcomeId]);
  return { ...state, setOutcome: (outcome: Outcome) => setState({ outcome, error: null }) };
};
