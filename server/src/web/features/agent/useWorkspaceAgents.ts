import { useCallback, useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request, settle } from "../../api";
import { workspaceApiPath } from "../../paths";
import { canOperateWorkspace } from "../access";
import { credentialsPath, scopeCredentialsPath, type Credential } from "../credential";
import { executionPath, type ExecutionOverview } from "../execution";
import { grantsPath, scopeGrantsPath } from "../grant";
import type { HumanRole } from "../member";
import { agentRunsPath, type AgentRuns } from "./agentRuns";
import { summarizeWorkspaceAgents, type ProjectAgentSource, type ScopeGrant, type WorkspaceAgents } from "./agents";

export type AgentProject = { id: string; name: string };

export type LoadedWorkspaceAgents = {
  agents: WorkspaceAgents;
  /** 登録先に選べるactiveなProject。 */
  projects: AgentProject[];
  /** 読み込めなかったProject。そのProjectのGrant・Credential・Claimは一覧に含まれていない（0件とは扱わない）。 */
  failedProjects: { project: AgentProject; error: string }[];
  /** 実行観測（Ralph・Orchestratorの報告）。取得できなければ`error`で、観測なし・停止とは区別する。 */
  runs: AgentRuns | { error: string };
  fetchedAt: number;
};

const projectNotFound = "Projectが見つからないか、閲覧する権限がありません。";

/** Project 1件のGrant・Agent Credential（参照できる場合）・Claim。 */
const loadProject = (project: AgentProject, showCredentials: boolean): Promise<ProjectAgentSource> =>
  Promise.all([
    request<{ grants: ScopeGrant[] }>(grantsPath(project.id)),
    showCredentials ? request<{ credentials: Credential[] }>(credentialsPath(project.id)) : Promise.resolve(null),
    request<ExecutionOverview>(executionPath(project.id)),
  ]).then(([{ grants }, credentials, overview]) => ({ project, grants, credentials: credentials?.credentials ?? null, tasks: overview.tasks }));

/**
 * WorkspaceのAgent管理の読込。Workspace Grant・Workspace Credentialと、activeな所属ProjectごとのProject Grant・Project Credential・
 * Claim（`execution`）と、Workspaceの実行観測（`agent-runs`）を既存のWeb APIから読み、Principalごとにまとめる。CredentialはWorkspaceのadministrator以上にだけ読む
 * （Project CredentialもWorkspace MembershipのRoleで認可される）。Projectごとの読込失敗は空と区別して残す。
 */
export const useWorkspaceAgents = (workspace: { id: string; name: string }, myRole: HumanRole) => {
  const showCredentials = canOperateWorkspace(myRole, "credential.manage");
  const key = `${workspace.id}/${showCredentials}`;
  const [state, setState] = useState<{ key: string; loaded: LoadedWorkspaceAgents | null; error: string | null; pending: boolean } | null>(null);
  const reload = useCallback((isCurrent: () => boolean = () => true) => {
    setState((current) => ({ key, loaded: current?.key === key ? current.loaded : null, error: null, pending: true }));
    const fetchedAt = Date.now();
    const scope = { kind: "workspace", id: workspace.id } as const;
    return Promise.all([
      request<{ grants: ScopeGrant[] }>(scopeGrantsPath(scope)),
      showCredentials ? request<{ credentials: Credential[] }>(scopeCredentialsPath(scope)) : Promise.resolve(null),
      request<{ projects: AgentProject[] }>(workspaceApiPath(workspace.id, "/projects")),
      settle(request<AgentRuns>(agentRunsPath(workspace.id)), "実行観測を読む権限がありません。"),
    ])
      .then(async ([{ grants }, credentials, { projects }, runsPart]) => {
        const parts = await Promise.all(projects.map((project) => settle(loadProject(project, showCredentials), projectNotFound).then((part) => ({ project, part }))));
        const loadedProjects = parts.flatMap(({ part }) => (part.ok ? [part.value] : []));
        const failedProjects = parts.flatMap(({ project, part }) => (part.ok ? [] : [{ project, error: part.error }]));
        const agents = summarizeWorkspaceAgents({ workspace, workspaceGrants: grants, workspaceCredentials: credentials?.credentials ?? null, projects: loadedProjects, now: fetchedAt, observedPrincipalIds: runsPart.ok ? runsPart.value.runs.map((run) => run.principalId) : [] });
        const runs = runsPart.ok ? runsPart.value : { error: runsPart.error };
        if (isCurrent()) setState({ key, loaded: { agents, projects, failedProjects, runs, fetchedAt }, error: null, pending: false });
      })
      .catch((reason: unknown) => {
        if (isCurrent()) setState({ key, loaded: null, error: loadFailureMessage(classifyError(reason), "Workspaceが見つからないか、このWorkspaceを閲覧する権限がありません。"), pending: false });
      });
  }, [key, workspace.name]);
  useEffect(() => {
    let current = true;
    void reload(() => current);
    return () => { current = false; };
  }, [reload]);
  const current = state?.key === key ? state : { loaded: null, error: null, pending: true };
  return { ...current, reload: () => void reload(), showCredentials };
};
