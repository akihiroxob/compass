import { request } from "../../api";
import { workspaceApiPath } from "../../paths";
import type { IntentMetrics } from "./metric";
import type { IntentExplanations } from "./explanation";

/** 観測項目と30日の時系列。範囲を指定しない取得はserverの既定（今日までの30日）で、7日はその部分として切り出す。 */
export const loadIntentMetrics = (workspaceId: string, intentId: string): Promise<IntentMetrics> =>
  request<IntentMetrics>(workspaceApiPath(workspaceId, `/intents/${intentId}/metrics`));

export const loadIntentExplanations = (workspaceId: string, intentId: string): Promise<IntentExplanations> =>
  request<IntentExplanations>(workspaceApiPath(workspaceId, `/intents/${intentId}/explanations`));
