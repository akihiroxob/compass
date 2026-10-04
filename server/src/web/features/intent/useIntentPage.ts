import { useEffect, useState } from "react";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import type { Intent } from "../../intentForm";

/** サーバーのNOT_FOUNDメッセージ（Project/Intentで先頭語が異なる）から、どちらが存在しないかを区別する。 */
export const useIntentPage = (projectId: string, intentId: string) => {
  const [state, setState] = useState<{ intent: Intent | null; error: string | null }>({ intent: null, error: null });
  useEffect(() => { request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}`).then(({ intent }) => setState({ intent, error: null })).catch((reason: unknown) => setState({ intent: null, error: reason instanceof ApiError && reason.status === 404 && reason.message.startsWith("Intent") ? "Intentが見つかりません。" : loadFailureMessage(classifyError(reason), "Projectが見つかりません。") })); }, [projectId, intentId]);
  return { ...state, setIntent: (intent: Intent) => setState({ intent, error: null }) };
};
