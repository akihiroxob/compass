import { Link, useParams } from "react-router-dom";
import { jsonInit, jsonPost, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { Shell } from "../../components/Shell";
import { emptyIntentFormValues, formValuesFromIntent, intentStatusLabels, type Intent } from "../../intentForm";
import { intentPath } from "../../paths";
import { IntentForm } from "./IntentForm";
import { useIntentPage } from "./useIntentPage";

export const IntentCreatePage = () => { const { projectId = "" } = useParams(); return <IntentForm projectId={projectId} initial={emptyIntentFormValues} heading={{ eyebrow: "New intent", title: "Intentを登録", lede: "必須なのはタイトルと実現したい状態です。Activeなintentは1つのProjectにつき1件までです。" }} submitLabel="Intentを登録" pendingLabel="登録中..." cancelTo={`/projects/${projectId}`} save={async (values) => (await request<{ intent: Intent }>(`/api/projects/${projectId}/intents`, jsonPost(values))).intent} />; };

export const IntentEditPage = () => {
  const { projectId = "", intentId = "" } = useParams(); const { intent, error } = useIntentPage(projectId, intentId); const back = intentPath(projectId, intentId);
  if (error) return <Shell><main className="narrow"><Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link><ErrorState message={error} /></main></Shell>;
  if (!intent) return <Shell><main className="narrow"><Loading /></main></Shell>;
  if (intent.status !== "active") return <Shell><main className="narrow"><Link to={back} className="back-link">← Intent詳細</Link><ErrorState message={`${intentStatusLabels[intent.status]}のIntentは編集できません。`} /></main></Shell>;
  return <IntentForm projectId={projectId} initial={formValuesFromIntent(intent)} heading={{ eyebrow: "Edit intent", title: "Intentを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={back} save={async (values) => (await request<{ intent: Intent }>(`/api/projects/${projectId}/intents/${intentId}`, jsonInit("PATCH", values))).intent} />;
};
