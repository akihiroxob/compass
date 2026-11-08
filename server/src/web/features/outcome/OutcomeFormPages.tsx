import { Link, useLocation, useParams } from "react-router-dom";
import { jsonInit, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { WorkspaceDirectionGate } from "../access";
import { emptyOutcomeFormValues, formValuesFromOutcome, outcomeStatusLabels, problemsInput, type Outcome, type OutcomeFormValues } from "./outcome";
import { intentPath, outcomePath, workspaceApiPath, workspaceOutcomePath, workspacePath } from "../../paths";
import { createOutcome } from "./createOutcome";
import { OutcomeForm } from "./OutcomeForm";
import { useIntentVersion } from "./useIntentVersion";
import { useOutcomePage } from "./useOutcomePage";

const createLede = "選んだビジネス目標に結び付けて、Outcomeと成功条件、課題ごとの根拠・解決策の仮説を登録します。Researchは必須ではありません。保存してもAgentは起動しません。";
const editLede = "変更した内容は保存するまで反映されません。キャンセルすると保存済みの内容のままです。";

/** 課題は一覧全体の置換のため、読み込んだ版を`expectedRevision`として送り、他での更新を上書きしない。 */
const updateOutcome = (workspaceId: string, outcome: Outcome) => async (values: OutcomeFormValues) =>
  (await request<{ outcome: Outcome }>(workspaceApiPath(workspaceId, `/intents/${outcome.intentId}/outcomes/${outcome.id}`), jsonInit("PATCH", { title: values.title, hypothesis: values.hypothesis, problems: problemsInput(values.problems), expectedRevision: outcome.revision }))).outcome;

/** 画面の配置ごとの戻り先・保存後の行き先。Project配下はIntent・Outcome詳細、Workspace配下はWorkspaceのOutcome詳細。 */
type Placement = { back: { to: string; label: string }; savedTo: (outcome: Outcome) => string; detailTo: string; conflictTo: { to: string; label: string }; state?: unknown };

const projectPlacement = (projectId: string, intentId: string, outcomeId?: string): Placement => ({
  back: outcomeId ? { to: outcomePath(projectId, intentId, outcomeId), label: "← Outcome詳細" } : { to: intentPath(projectId, intentId), label: "← Intent詳細" },
  savedTo: (outcome) => outcomePath(projectId, intentId, outcome.id),
  detailTo: `/projects/${projectId}`,
  conflictTo: outcomeId ? { to: outcomePath(projectId, intentId, outcomeId), label: "最新のOutcomeを開く →" } : { to: intentPath(projectId, intentId), label: "Intentを開く →" },
});

/** Workspace配下の配置。`state`（Outcome一覧の絞り込み条件）は戻る・キャンセル・保存後の遷移へ引き継ぐ。 */
export const workspacePlacement = (workspaceId: string, intentId: string, outcomeId: string | undefined, state: unknown): Placement => {
  const direction = workspacePath(workspaceId, "direction");
  return {
    state,
    back: outcomeId ? { to: workspaceOutcomePath(workspaceId, intentId, outcomeId), label: "← Outcome詳細" } : { to: direction, label: "← Outcome" },
    savedTo: (outcome) => workspaceOutcomePath(workspaceId, intentId, outcome.id),
    detailTo: direction,
    conflictTo: outcomeId ? { to: workspaceOutcomePath(workspaceId, intentId, outcomeId), label: "最新のOutcomeを開く →" } : { to: direction, label: "Outcomeの一覧を開く →" },
  };
};

const conflictLink = (placement: Placement) => <Link to={placement.conflictTo.to} state={placement.state} className="text-link">{placement.conflictTo.label}</Link>;

/** フォームを開いた時点のIntent版を保持して送る。送信時に現在版へ付け替えないため、入力中に目標が更新されていれば409になる。 */
const CreateForm = ({ workspaceId, intentId, placement }: { workspaceId: string; intentId: string; placement: Placement }) => {
  const { version, error } = useIntentVersion(workspaceId, intentId);
  if (error) return <main className="narrow"><Link to={placement.back.to} state={placement.state} className="back-link">{placement.back.label}</Link><ErrorState message={error} /></main>;
  if (version === null) return <main className="narrow"><Loading /></main>;
  return <OutcomeForm workspaceId={workspaceId} mode="create" initial={emptyOutcomeFormValues} heading={{ eyebrow: "New outcome", title: "Outcomeを追加", lede: createLede }} submitLabel="Outcomeを追加" pendingLabel="追加中..." cancelTo={placement.back.to} linkState={placement.state} save={createOutcome(workspaceId, intentId, version)} savedTo={placement.savedTo} detailTo={placement.detailTo} conflictAction={conflictLink(placement)} />;
};

const EditForm = ({ workspaceId, intentId, outcomeId, placement }: { workspaceId: string; intentId: string; outcomeId: string; placement: Placement }) => {
  const { outcome, error } = useOutcomePage(workspaceId, intentId, outcomeId);
  if (error) return <main className="narrow"><Link to={placement.back.to} state={placement.state} className="back-link">{placement.back.label}</Link><ErrorState message={error} /></main>;
  if (!outcome) return <main className="narrow"><Loading /></main>;
  if (outcome.status !== "active") return <main className="narrow"><Link to={placement.back.to} state={placement.state} className="back-link">{placement.back.label}</Link><ErrorState message={`${outcomeStatusLabels[outcome.status]}のOutcomeは編集できません。`} /></main>;
  return <OutcomeForm workspaceId={workspaceId} mode="edit" initial={formValuesFromOutcome(outcome)} heading={{ eyebrow: "Edit outcome", title: "Outcomeを編集", lede: editLede }} submitLabel="変更を保存" pendingLabel="保存中..." cancelTo={placement.back.to} linkState={placement.state} save={updateOutcome(workspaceId, outcome)} savedTo={placement.savedTo} detailTo={placement.detailTo} conflictAction={conflictLink(placement)} />;
};

export const OutcomeCreatePage = () => {
  const { projectId = "", intentId = "" } = useParams();
  const placement = projectPlacement(projectId, intentId);
  return <WorkspaceDirectionGate scope={{ projectId }} back={placement.back}>{(workspaceId) => <CreateForm workspaceId={workspaceId} intentId={intentId} placement={placement} />}</WorkspaceDirectionGate>;
};

export const OutcomeEditPage = () => {
  const { projectId = "", intentId = "", outcomeId = "" } = useParams();
  const placement = projectPlacement(projectId, intentId, outcomeId);
  return <WorkspaceDirectionGate scope={{ projectId }} back={placement.back}>{(workspaceId) => <EditForm workspaceId={workspaceId} intentId={intentId} outcomeId={outcomeId} placement={placement} />}</WorkspaceDirectionGate>;
};

/** Workspaceのビジネス目標から開くOutcomeの追加。URLを直接開いた場合もWorkspace Membershipで変更できるときだけフォームを出す。 */
export const WorkspaceOutcomeCreatePage = () => {
  const { workspaceId = "", intentId = "" } = useParams();
  const placement = workspacePlacement(workspaceId, intentId, undefined, useLocation().state);
  return <WorkspaceDirectionGate scope={{ workspaceId }} back={placement.back}>{(id) => <CreateForm workspaceId={id} intentId={intentId} placement={placement} />}</WorkspaceDirectionGate>;
};

export const WorkspaceOutcomeEditPage = () => {
  const { workspaceId = "", intentId = "", outcomeId = "" } = useParams();
  const placement = workspacePlacement(workspaceId, intentId, outcomeId, useLocation().state);
  return <WorkspaceDirectionGate scope={{ workspaceId }} back={placement.back}>{(id) => <EditForm workspaceId={id} intentId={intentId} outcomeId={outcomeId} placement={placement} />}</WorkspaceDirectionGate>;
};
