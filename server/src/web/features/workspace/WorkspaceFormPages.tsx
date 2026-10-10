import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import type { HumanWorkspaceOperation } from "@compass/access/domain";
import { classifyError, jsonInit, loadFailureMessage, request, withNotFoundMessage } from "../../api";
import { FormErrorSummary, fieldProps, invalidFieldIds, type FormError } from "../../components/FormErrorSummary";
import { TextListInput } from "../../components/ListInputs";
import { Shell } from "../../components/Shell";
import { ErrorState, Loading } from "../../components/StateCard";
import { workspaceApiPath } from "../../paths";
import { canOperateWorkspace } from "../../permissions";
import { projectOperationAccess, projectOperationDeniedMessage } from "../../projectAccess";
import { emptyFormValues, type Project } from "../../projectForm";
import type { HumanRole } from "../member";
import { ProjectForm } from "../project";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { workspacePath, workspaceProjectsPath, type Workspace } from "./workspace";
import { emptyWorkspaceFormValues, workspaceFormValues, type WorkspaceFormValues } from "./workspaceForm";

const workspaceNotFound = "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。";

type WorkspaceFormProps = {
  initial: WorkspaceFormValues;
  heading: { eyebrow: string; title: string; lede: string };
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
    <Shell>
      <main className="narrow">
        <Link to={back.to} className="back-link">← {back.label}</Link>
        <div className="page-heading"><div><p className="eyebrow">{heading.eyebrow}</p><h1>{heading.title}</h1></div></div>
        <p className="lede">{heading.lede}</p>
        {error && <FormErrorSummary error={error} detailTo={back.to} archivedScope="Workspace" />}
        <form onSubmit={submit} className="project-form">
          <section className="form-section">
            <h2>Identity</h2>
            <label>Workspace名 <span>必須</span><input {...fieldProps(invalid, "field-name")} required aria-required="true" maxLength={100} value={name} onChange={(event) => setName(event.target.value)} /></label>
          </section>
          <section className="form-section">
            <h2>Direction</h2>
            <label>Mission <span>必須</span><small>このWorkspaceが存在する理由。所属するすべてのProjectで共有します</small><textarea {...fieldProps(invalid, "field-mission")} required aria-required="true" maxLength={2000} rows={5} value={mission} onChange={(event) => setMission(event.target.value)} /></label>
            <label>Vision<small>最終的に実現したい状態</small><textarea {...fieldProps(invalid, "field-vision")} maxLength={2000} rows={5} value={vision} onChange={(event) => setVision(event.target.value)} /></label>
            <TextListInput legend="Principles" name="principles" invalid={invalid} values={principles} setValues={setPrinciples} placeholder="迷ったときの判断原則" />
            <TextListInput legend="Constraints" name="constraints" invalid={invalid} values={constraints} setValues={setConstraints} placeholder="超えてはいけない制約" />
          </section>
          <div className="form-actions"><Link to={back.to} className="secondary-button">キャンセル</Link><button className="button" disabled={isSubmitting}>{isSubmitting ? pendingLabel : submitLabel}</button></div>
        </form>
      </main>
    </Shell>
  );
};

/** Workspaceの作成。認証済みであれば作成でき、作成者がownerになる。 */
export const WorkspaceCreatePage = () => (
  <WorkspaceForm
    initial={emptyWorkspaceFormValues}
    heading={{ eyebrow: "New workspace", title: "Workspaceを作成", lede: "Workspaceは、Missionを共有して複数のProjectで成果を実現する単位です。必須なのは名前とMissionです。作成後にProjectを追加します。" }}
    submitLabel="Workspaceを作成"
    pendingLabel="作成中..."
    back={{ to: "/", label: "ホーム" }}
    save={async (values) => (await request<{ workspace: Workspace }>("/api/workspaces", jsonInit("POST", values))).workspace}
  />
);

type WorkspaceGateState = { key: string; state: { access: "allowed"; workspace: Workspace } | { access: "denied"; message: string } };

/**
 * Workspaceの編集・Project追加の画面をURLで直接開いた場合も、Workspaceのstatusと`myRole`（Workspace Membership）で`operation`を
 * 行えるときだけ`children`を描画する。Project Membershipからは継承しない。行えないときは理由と戻り先だけを出す（拒否は常にserverが行う）。
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
  return <Shell><main className="narrow"><Link to={workspacePath(workspaceId)} className="back-link">← Workspaceの概要</Link>{state ? <ErrorState message={state.message} /> : <Loading />}</main></Shell>;
};

/** Mission等の編集（Workspace Membershipのadministrator以上）。 */
export const WorkspaceEditPage = () => (
  <WorkspaceOperationGate operation="workspace.update">
    {(workspace) => (
      <WorkspaceForm
        initial={workspaceFormValues(workspace)}
        heading={{ eyebrow: "Edit workspace", title: "Workspaceを編集", lede: "変更した内容は保存するまで反映されません。Mission等は所属するすべてのProjectで共有されます。" }}
        submitLabel="変更を保存"
        pendingLabel="保存中..."
        back={{ to: workspacePath(workspace.id), label: "Workspaceの概要" }}
        save={async (values) => (await request<{ workspace: Workspace }>(workspaceApiPath(workspace.id), jsonInit("PATCH", values))).workspace}
      />
    )}
  </WorkspaceOperationGate>
);

/** 既存WorkspaceへのProject追加（Workspace Membershipのadministrator以上）。作成者はProjectのownerになる。 */
export const WorkspaceProjectCreatePage = () => {
  const navigation = useWorkspaceNavigation();
  return (
    <WorkspaceOperationGate operation="project.create">
      {(workspace) => (
        <ProjectForm
          initial={emptyFormValues}
          heading={{ eyebrow: `Workspace · ${workspace.name}`, title: "Projectを追加", lede: "ProjectはWorkspaceのMissionを実現する実行の単位です。Mission等はWorkspaceの値を共有するため、ここでは名前・説明・Repository・Resourceを登録します。あなたがこのProjectのownerになります。" }}
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
