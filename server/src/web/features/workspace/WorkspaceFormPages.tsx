import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { HumanWorkspaceOperation } from "@compass/access/domain";
import { classifyError, jsonInit, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { TextListInput } from "../../components/ListInputs";
import { ErrorState, Loading } from "../../components/StateCard";
import { Button, Field, LinkButton, TextArea, TextInput } from "../../components/ui";
import { workspaceApiPath, workspacePath, workspaceProjectsPath } from "../../paths";
import { canOperateWorkspace, projectOperationAccess, projectOperationDeniedMessage } from "../access";
import type { HumanRole } from "../member";
import { emptyFormValues, ProjectForm, type Project } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import type { Workspace } from "./workspace";
import { emptyWorkspaceFormValues, workspaceFormValues, type WorkspaceFormValues } from "./workspaceForm";

const workspaceNotFound = "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。";

type WorkspaceFormProps = {
  initial: WorkspaceFormValues;
  heading: { title: string; lede: string };
  submitLabel: string;
  pendingLabel: string;
  back: { to: string; label: string };
  save: (values: WorkspaceFormValues) => Promise<Workspace>;
};

/** Workspaceの作成・編集フォーム。Mission等はWorkspaceが正本で、所属Projectはこの値を参照する。 */
const WorkspaceForm = ({ initial, heading, submitLabel, pendingLabel, back, save }: WorkspaceFormProps) => {
  const navigate = useNavigate();
  const navigation = useWorkspaceNavigation();
  const [name, setName] = useState(initial.name);
  const [mission, setMission] = useState(initial.mission);
  const [vision, setVision] = useState(initial.vision);
  const [principles, setPrinciples] = useState(initial.principles);
  const [constraints, setConstraints] = useState(initial.constraints);
  const [error, setError] = useState<FormError | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const invalid = invalidFieldIds(error);
  // 保存に失敗しても入力stateは維持し、そのまま再送信できる。
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const workspace = await save({ name, mission, vision, principles, constraints });
      // Selector・Shellの名前・Missionと一覧を、保存した状態へ揃える。
      navigation?.refreshWorkspace(workspace.id);
      navigate(workspacePath(workspace.id));
    } catch (reason) {
      setError(withNotFoundMessage(classifyError(reason), workspaceNotFound));
    } finally {
      setIsSubmitting(false);
    }
  };
  return (
    <main className="narrow">
      <Link to={back.to} className="back-link">← {back.label}</Link>
      <div className="page-heading"><h1>{heading.title}</h1></div>
      <p className="lede">{heading.lede}</p>
      {error && <FormErrorSummary error={error} conflict={{ title: "保存が競合しました。入力内容は残っています" }} detailTo={back.to} archivedScope="Workspace" />}
      <form onSubmit={submit} className="project-form">
        <section className="form-section">
          <Field label="Workspace名" required="＊"><TextInput {...fieldProps(invalid, "field-name")} required maxLength={100} placeholder="学びの支援" value={name} onChange={(event) => setName(event.target.value)} /></Field>
          <Field label="Mission" required="＊" description="このWorkspaceで取り組む目的や、届けたい価値です。"><TextArea {...fieldProps(invalid, "field-mission")} required maxLength={2000} rows={5} placeholder="学びたい人が、自分に合う学び方を見つけられるようにする。" value={mission} onChange={(event) => setMission(event.target.value)} /></Field>
          <Field label="Vision" description="活動を続けた先で、実現したい社会や利用者の状態です。"><TextArea {...fieldProps(invalid, "field-vision")} maxLength={2000} rows={5} placeholder="誰もが学びを続け、新しいことに挑戦できる社会。" value={vision} onChange={(event) => setVision(event.target.value)} /></Field>
          <TextListInput legend="判断の原則" description="複数の選択肢があるときに、何を優先するかを決める考え方です。" name="principles" invalid={invalid} values={principles} setValues={setPrinciples} placeholder="機能数より使いやすさを優先する。" />
          <TextListInput legend="制約" description="予算・技術・運用など、活動で守る必要がある条件です。" name="constraints" invalid={invalid} values={constraints} setValues={setConstraints} placeholder="個人情報を外部サービスに送信しない。" />
        </section>
        <div className="form-actions"><LinkButton to={back.to} variant="secondary">キャンセル</LinkButton><Button type="submit" pending={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</Button></div>
      </form>
    </main>
  );
};

/** Workspaceの作成。認証済みであれば作成でき、作成者がownerになる。 */
export const WorkspaceCreatePage = () => (
  <WorkspaceForm
    initial={emptyWorkspaceFormValues}
    heading={{ title: "Workspaceを作成", lede: "WorkspaceでMission・Visionを共有し、複数のProjectを進めます。ProjectはWorkspaceの作成後に追加できます。" }}
    submitLabel="Workspaceを作成"
    pendingLabel="作成中..."
    back={{ to: "/", label: "ホーム" }}
    save={async (values) => (await request<{ workspace: Workspace }>("/api/workspaces", jsonInit("POST", values))).workspace}
  />
);

type WorkspaceGateState = { key: string; state: { access: "allowed"; workspace: Workspace } | { access: "denied"; message: string } };

/**
 * Workspaceの編集・Project追加の画面をURLで直接開いた場合も、Workspaceのstatusと`myRole`（Workspace Membership）で`operation`を
 * 行えるときだけ`children`を描画する。行えないときは理由と戻り先だけを出す（拒否は常にserverが行う）。
 */
const WorkspaceOperationGate = ({ operation, children }: { operation: HumanWorkspaceOperation; children: (workspace: Workspace) => ReactNode }) => {
  const { workspaceId = "" } = useParams();
  const [stored, setStored] = useState<WorkspaceGateState | null>(null);
  const key = `${workspaceId}/${operation}`;
  useEffect(() => {
    let current = true;
    request<{ workspace: Workspace; myRole: HumanRole }>(workspaceApiPath(workspaceId))
      .then(({ workspace, myRole }) => {
        const access = projectOperationAccess(workspace, canOperateWorkspace(myRole, operation));
        return access === "allowed" ? { access, workspace } as const : { access: "denied", message: projectOperationDeniedMessage(access, "Workspace") } as const;
      })
      .catch((reason: unknown) => ({ access: "denied", message: loadFailureMessage(classifyError(reason), workspaceNotFound) } as const))
      .then((state) => { if (current) setStored({ key, state }); });
    return () => { current = false; };
  }, [key]);
  const state = stored?.key === key ? stored.state : null;
  if (state?.access === "allowed") return <>{children(state.workspace)}</>;
  return <main className="narrow"><Link to={workspacePath(workspaceId)} className="back-link">← Workspaceの概要</Link>{state ? <ErrorState message={state.message} /> : <Loading />}</main>;
};

/** Mission等の編集（Workspace Membershipのadministrator以上）。 */
export const WorkspaceEditPage = () => (
  <WorkspaceOperationGate operation="workspace.update">
    {(workspace) => (
      <WorkspaceForm
        initial={workspaceFormValues(workspace)}
        heading={{ title: "Workspaceを編集", lede: "変更した内容は保存するまで反映されません。Mission等は所属するすべてのProjectで共有されます。" }}
        submitLabel="変更を保存"
        pendingLabel="保存中..."
        back={{ to: workspacePath(workspace.id), label: "Workspaceの概要" }}
        save={async (values) => (await request<{ workspace: Workspace }>(workspaceApiPath(workspace.id), jsonInit("PATCH", { ...values, expectedUpdatedAt: workspace.updatedAt }))).workspace}
      />
    )}
  </WorkspaceOperationGate>
);

/** 既存WorkspaceへのProject追加（Workspace Membershipのadministrator以上）。WorkspaceのMemberが同じRoleで利用する。 */
export const WorkspaceProjectCreatePage = () => {
  const navigation = useWorkspaceNavigation();
  return (
    <WorkspaceOperationGate operation="project.create">
      {(workspace) => (
        <ProjectForm
          initial={emptyFormValues}
          heading={{ eyebrow: `Workspace · ${workspace.name}`, title: "Projectを追加", lede: "ProjectはWorkspaceのMissionを実現する実行の単位です。Mission等はWorkspaceの値を共有するため、ここでは名前・説明と、任意のRepository URLを登録します。Resourceや追加のRepositoryは作成後の設定から追加できます。WorkspaceのMemberは、それぞれのWorkspaceのRoleでこのProjectを利用できます。" }}
          submitLabel="Projectを追加"
          pendingLabel="追加中..."
          back={{ to: workspaceProjectsPath(workspace.id), label: "WorkspaceのProject" }}
          archivedScope="Workspace"
          notFound={workspaceNotFound}
          save={async (values) => {
            const { project } = await request<{ project: Project }>(workspaceApiPath(workspace.id, "/projects"), jsonInit("POST", values));
            navigation?.refreshWorkspace(workspace.id);
            return project;
          }}
        />
      )}
    </WorkspaceOperationGate>
  );
};
