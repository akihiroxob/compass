import { jsonPost, request, type FetchLike } from "../../api.ts";
import { workspaceApiPath } from "../../paths.ts";
import { createOutcomeBody, problemsInput, type Outcome, type OutcomeFormValues } from "./outcome.ts";

/** フォーム表示時点のIntent版を本文に含めてOutcomeを登録する。版はサーバーが現在版と照合する。 */
export const createOutcome = (workspaceId: string, intentId: string, intentVersion: number, fetchImpl?: FetchLike) => async (values: OutcomeFormValues) =>
  (await request<{ outcome: Outcome }>(workspaceApiPath(workspaceId, `/intents/${intentId}/outcomes`), jsonPost(createOutcomeBody({ ...values, problems: problemsInput(values.problems) }, intentVersion)), fetchImpl)).outcome;
