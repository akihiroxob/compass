import { Link, useParams } from "react-router-dom";
import { jsonInit, jsonPost, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { WorkspaceDirectionGate } from "../access";
import { emptyIntentFormValues, formValuesFromIntent, intentStatusLabels, type Intent, type IntentFormValues } from "./intent";
import { intentPath, workspaceApiPath, workspaceIntentPath, workspacePath } from "../../paths";
import { IntentForm } from "./IntentForm";
import { useIntentPage } from "./useIntentPage";

const createLede = "必須なのは目標名と実現したい状態です。目標は所属Workspaceのもので、複数の目標を同時に進められます。保存してもAgentは起動しません。";
const editLede = "変更した内容は保存するまで反映されません。保存すると新しい版になり、変更者と理由が履歴に残ります。キャンセルすると保存済みの内容のままです。";

const createIntent = (workspaceId: string) => async (values: IntentFormValues) =>
  (await request<{ intent: Intent }>(workspaceApiPath(workspaceId, "/intents"), jsonPost(values))).intent;
const updateIntent = (workspaceId: string, intentId: string) => async (values: IntentFormValues, { expectedVersion, reason }: { expectedVersion: number | null; reason: string }) =>
  (await request<{ intent: Intent }>(workspaceApiPath(workspaceId, `/intents/${intentId}`), jsonInit("PATCH", { ...values, expectedVersion, reason }))).intent;
const loadIntent = (workspaceId: string, intentId: string) => async () =>
  (await request<{ intent: Intent }>(workspaceApiPath(workspaceId, `/intents/${intentId}`))).intent;

/** 画面の配置ごとの戻り先・保存後の行き先。Project配下はIntent詳細、Workspace配下は方向（Outcome）の画面。 */
type Placement = { back: { to: string; label: string }; savedTo: (intent: Intent) => string; activeIntentTo: (intentId: string) => string; detailTo: string };

const projectPlacement = (projectId: string, intentId?: string): Placement => ({
  back: intentId ? { to: intentPath(projectId, intentId), label: "← Intent詳細" } : { to: `/projects/${projectId}`, label: "← Project詳細" },
  savedTo: (intent) => intentPath(projectId, intent.id),
  activeIntentTo: (id) => intentPath(projectId, id),
  detailTo: `/projects/${projectId}`,
});

/** Workspace配下の目標。作成はWorkspace概要から、編集は目標詳細から開き、保存後は目標詳細へ戻る。 */
const workspacePlacement = (workspaceId: string, intentId?: string): Placement => {
  const overview = workspacePath(workspaceId);
  return {
    back: intentId ? { to: workspaceIntentPath(workspaceId, intentId), label: "← 目標詳細" } : { to: overview, label: "← Workspace概要" },
    savedTo: (intent) => workspaceIntentPath(workspaceId, intent.id),
    activeIntentTo: (id) => workspaceIntentPath(workspaceId, id),
    detailTo: overview,
  };
};

const CreateForm = ({ workspaceId, placement }: { workspaceId: string; placement: Placement }) => (
  <IntentForm initial={emptyIntentFormValues} heading={{ eyebrow: "New goal", title: "目標を作成", lede: createLede }} submitLabel="作成" pendingLabel="作成中..." cancelTo={placement.back.to} save={createIntent(workspaceId)} savedTo={placement.savedTo} activeIntentTo={placement.activeIntentTo} detailTo={placement.detailTo} />
);

const EditForm = ({ workspaceId, intentId, placement }: { workspaceId: string; intentId: string; placement: Placement }) => {
  const { intent, error } = useIntentPage(workspaceId, intentId);
  if (error) return <main className="narrow"><Link to={placement.back.to} className="back-link">{placement.back.label}</Link><ErrorState message={error} /></main>;
  if (!intent) return <main className="narrow"><Loading /></main>;
  if (intent.status !== "active") return <main className="narrow"><Link to={placement.back.to} className="back-link">{placement.back.label}</Link><ErrorState message={`${intentStatusLabels[intent.status]}の目標は編集できません。`} /></main>;
  return <IntentForm initial={formValuesFromIntent(intent)} heading={{ eyebrow: "Edit goal", title: "目標を編集", lede: editLede }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={placement.back.to} save={updateIntent(workspaceId, intentId)} edit={{ version: intent.version, reload: loadIntent(workspaceId, intentId) }} savedTo={placement.savedTo} activeIntentTo={placement.activeIntentTo} detailTo={placement.detailTo} />;
};

export const IntentCreatePage = () => {
  const { projectId = "" } = useParams();
  const placement = projectPlacement(projectId);
  return <WorkspaceDirectionGate scope={{ projectId }} back={placement.back}>{(workspaceId) => <CreateForm workspaceId={workspaceId} placement={placement} />}</WorkspaceDirectionGate>;
};

export const IntentEditPage = () => {
  const { projectId = "", intentId = "" } = useParams();
  const placement = projectPlacement(projectId, intentId);
  return <WorkspaceDirectionGate scope={{ projectId }} back={placement.back}>{(workspaceId) => <EditForm workspaceId={workspaceId} intentId={intentId} placement={placement} />}</WorkspaceDirectionGate>;
};

/** Workspaceの方向から開く目標の作成。URLを直接開いた場合もWorkspace Membershipで変更できるときだけフォームを出す。 */
export const WorkspaceIntentCreatePage = () => {
  const { workspaceId = "" } = useParams();
  const placement = workspacePlacement(workspaceId);
  return <WorkspaceDirectionGate scope={{ workspaceId }} back={placement.back}>{(id) => <CreateForm workspaceId={id} placement={placement} />}</WorkspaceDirectionGate>;
};

export const WorkspaceIntentEditPage = () => {
  const { workspaceId = "", intentId = "" } = useParams();
  const placement = workspacePlacement(workspaceId, intentId);
  return <WorkspaceDirectionGate scope={{ workspaceId }} back={placement.back}>{(id) => <EditForm workspaceId={id} intentId={intentId} placement={placement} />}</WorkspaceDirectionGate>;
};
