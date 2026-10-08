import { useEffect, useState } from "react";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import type { Intent } from "../../intentForm";
import { workspaceApiPath } from "../../paths";

/**
 * 所属WorkspaceのIntentを読む（`workspaceId`が判明するまでは読まない）。
 * サーバーのNOT_FOUNDメッセージ（Workspace/Intentで先頭語が異なる）から、どちらが存在しないかを区別する。
 */
export const useIntentPage = (workspaceId: string | null, intentId: string) => {
  const [state, setState] = useState<{ intent: Intent | null; error: string | null }>({ intent: null, error: null });
  useEffect(() => { if (workspaceId === null) return; request<{ intent: Intent }>(workspaceApiPath(workspaceId, `/intents/${intentId}`)).then(({ intent }) => setState({ intent, error: null })).catch((reason: unknown) => setState({ intent: null, error: reason instanceof ApiError && reason.status === 404 && reason.message.startsWith("Intent") ? "Intentが見つかりません。" : loadFailureMessage(classifyError(reason), "Workspaceが見つかりません。") })); }, [workspaceId, intentId]);
  return { ...state, setIntent: (intent: Intent) => setState({ intent, error: null }) };
};
