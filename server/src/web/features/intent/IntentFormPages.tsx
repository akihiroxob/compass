import { Link, useParams } from "react-router-dom";
import { jsonInit, jsonPost, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { WorkspaceDirectionGate } from "../../components/WorkspaceDirectionGate";
import { emptyIntentFormValues, formValuesFromIntent, intentStatusLabels, type Intent } from "../../intentForm";
import { intentPath, workspaceApiPath } from "../../paths";
import { IntentForm } from "./IntentForm";
import { useIntentPage } from "./useIntentPage";

export const IntentCreatePage = () => { const { projectId = "" } = useParams(); return <WorkspaceDirectionGate projectId={projectId} back={{ to: `/projects/${projectId}`, label: "← Project詳細" }}>{(workspaceId) => <IntentForm projectId={projectId} initial={emptyIntentFormValues} heading={{ eyebrow: "New intent", title: "Intentを登録", lede: "必須なのはタイトルと実現したい状態です。Intentは所属Workspaceのもので、Activeなintentは1つのWorkspaceにつき1件までです。" }} submitLabel="Intentを登録" pendingLabel="登録中..." cancelTo={`/projects/${projectId}`} save={async (values) => (await request<{ intent: Intent }>(workspaceApiPath(workspaceId, "/intents"), jsonPost(values))).intent} />}</WorkspaceDirectionGate>; };

export const IntentEditPage = () => { const { projectId = "", intentId = "" } = useParams(); return <WorkspaceDirectionGate projectId={projectId} back={{ to: intentPath(projectId, intentId), label: "← Intent詳細" }}>{(workspaceId) => <IntentEditForm projectId={projectId} workspaceId={workspaceId} intentId={intentId} />}</WorkspaceDirectionGate>; };

const IntentEditForm = ({ projectId, workspaceId, intentId }: { projectId: string; workspaceId: string; intentId: string }) => {
  const { intent, error } = useIntentPage(workspaceId, intentId); const back = intentPath(projectId, intentId);
  if (error) return <main className="narrow"><Link to={`/projects/${projectId}`} className="back-link">← Project詳細</Link><ErrorState message={error} /></main>;
  if (!intent) return <main className="narrow"><Loading /></main>;
  if (intent.status !== "active") return <main className="narrow"><Link to={back} className="back-link">← Intent詳細</Link><ErrorState message={`${intentStatusLabels[intent.status]}のIntentは編集できません。`} /></main>;
  return <IntentForm projectId={projectId} initial={formValuesFromIntent(intent)} heading={{ eyebrow: "Edit intent", title: "Intentを編集", lede: "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。" }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={back} save={async (values) => (await request<{ intent: Intent }>(workspaceApiPath(workspaceId, `/intents/${intentId}`), jsonInit("PATCH", values))).intent} />;
};
