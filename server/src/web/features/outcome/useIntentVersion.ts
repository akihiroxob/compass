import { useEffect, useState } from "react";
import { ApiError, classifyError, loadFailureMessage, request } from "../../api";
import { workspaceApiPath } from "../../paths";

/**
 * Outcome作成の判断元となるIntentの版を、画面を開いた時点で読む。
 * Intent Featureの内部に依存せず、公開APIの`version`だけを使う（Feature間の依存を非循環に保つ）。
 */
export const useIntentVersion = (workspaceId: string, intentId: string) => {
  const [state, setState] = useState<{ version: number | null; error: string | null }>({ version: null, error: null });
  useEffect(() => { request<{ intent: { version: number } }>(workspaceApiPath(workspaceId, `/intents/${intentId}`)).then(({ intent }) => setState({ version: intent.version, error: null })).catch((reason: unknown) => setState({ version: null, error: reason instanceof ApiError && reason.status === 404 && reason.message.startsWith("Intent") ? "Intentが見つかりません。" : loadFailureMessage(classifyError(reason), "Workspaceが見つかりません。") })); }, [workspaceId, intentId]);
  return state;
};
