import { Link, useParams } from "react-router-dom";
import { jsonInit, jsonPost, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { emptyOutcomeFormValues, formValuesFromOutcome, outcomeStatusLabels, type Outcome } from "../../outcomeForm";
import { intentPath, outcomePath } from "../../paths";
import { OutcomeForm } from "./OutcomeForm";
import { useOutcomePage } from "./useOutcomePage";

export const OutcomeCreatePage = () => { const { projectId = "", intentId = "" } = useParams(); return <OutcomeForm projectId={projectId} intentId={intentId} mode="create" initial={emptyOutcomeFormValues} heading={{ eyebrow: "New outcome", title: "Outcomeを登録", lede: "Strategist（またはHuman）の判断結果として、Intentへ近づくためのOutcomeと成功条件を登録します。Researchは必須ではありません。" }} submitLabel="Outcomeを登録" pendingLabel="登録中..." cancelTo={intentPath(projectId, intentId)} save={async (values) => (await request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes`, jsonPost(values))).outcome} />; };

export const OutcomeEditPage = () => {
  const { projectId = "", intentId = "", outcomeId = "" } = useParams(); const { outcome, error } = useOutcomePage(projectId, intentId, outcomeId); const back = outcomePath(projectId, intentId, outcomeId);
  if (error) return <Shell><main className="narrow"><Link to={intentPath(projectId, intentId)} className="back-link">← Intent詳細</Link><ErrorState message={error} /></main></Shell>;
  if (!outcome) return <Shell><main className="narrow"><Loading /></main></Shell>;
  if (outcome.status !== "active") return <Shell><main className="narrow"><Link to={back} className="back-link">← Outcome詳細</Link><ErrorState message={`${outcomeStatusLabels[outcome.status]}のOutcomeは編集できません。`} /></main></Shell>;
  return <OutcomeForm projectId={projectId} intentId={intentId} mode="edit" initial={formValuesFromOutcome(outcome)} heading={{ eyebrow: "Edit outcome", title: "Outcomeを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={back} save={async (values) => (await request<{ outcome: Outcome }>(`/api/projects/${projectId}/intents/${intentId}/outcomes/${outcomeId}`, jsonInit("PATCH", { title: values.title, hypothesis: values.hypothesis }))).outcome} />;
};
