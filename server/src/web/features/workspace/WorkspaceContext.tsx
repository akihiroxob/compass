import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { classifyError, loadFailureMessage, request, type FetchLike } from "../../api";
import type { Project } from "../../projectForm";
import { parseShellLocation, resolveCurrentWorkspace, type ShellLocation, type Workspace } from "./workspace";

const rememberedKey = "compass.workspaceId";
const readRemembered = (): string | null => {
  try {
    return window.localStorage.getItem(rememberedKey);
  } catch {
    return null;
  }
};
const remember = (workspaceId: string) => {
  try {
    window.localStorage.setItem(rememberedKey, workspaceId);
  } catch {
    // 保存できない環境（private mode等）では、ホームで一覧の先頭を開く。
  }
};

/**
 * Workspace一覧と、指定したWorkspaceの最新状態を同じ時点で取得する。指定したWorkspaceを閲覧できなければ`workspace`はnull。
 * Projectのarchiveで所属Workspaceもarchiveされうるため、一覧（activeのみ）と個別の状態を揃えて反映するのに使う。
 */
export const loadWorkspaceNavigation = async (workspaceId: string | null, fetchImpl?: FetchLike) => {
  const [{ workspaces }, workspace] = await Promise.all([
    request<{ workspaces: Workspace[] }>("/api/workspaces", undefined, fetchImpl),
    workspaceId === null ? Promise.resolve(null) : request<{ workspace: Workspace }>(`/api/workspaces/${workspaceId}`, undefined, fetchImpl).then(({ workspace }) => workspace, () => null),
  ]);
  return { workspaces, workspace };
};

type WorkspaceNavigation = {
  /** 有効なWorkspace Membershipを持つactiveなWorkspace。権限の無いWorkspaceはserverが返さない。再取得中はnull（古い一覧で遷移先を選ばない）。 */
  workspaces: Workspace[] | null;
  error: string | null;
  reload: () => void;
  /** Workspaceの状態が変わりうる操作（Projectのarchive等）の後に、一覧と当該Workspaceの状態を再取得する。 */
  refreshWorkspace: (workspaceId: string) => void;
  location: ShellLocation;
  /** 現在位置のWorkspace。Project配下はProjectの所属Workspace、それ以外は前回選択したWorkspace。 */
  currentId: string | null;
  /** 一覧に無い（archived・Membershipの無い）Workspaceは個別に取得し、閲覧できなければnull。 */
  current: Workspace | null;
  /** 現在のWorkspaceを解決中（一覧・Projectの所属・個別取得の待ち）。 */
  resolving: boolean;
  rememberedId: string | null;
};

const WorkspaceNavigationContext = createContext<WorkspaceNavigation | null>(null);

/** Shell・ホームが使うWorkspaceのナビゲーション。Providerの外（ログイン画面等）では`null`。 */
export const useWorkspaceNavigation = () => useContext(WorkspaceNavigationContext);

/**
 * Workspace一覧と、URLから決まる現在のWorkspaceを提供する。現在位置はURLが正本で、前回選択したWorkspaceは
 * ホームで開く先とWorkspaceを持たない画面の表示にだけ使う（localStorage）。表示の判定であり、拒否は常にserverが行う。
 */
export const WorkspaceNavigationProvider = ({ children }: { children: ReactNode }) => {
  const location = parseShellLocation(useLocation().pathname);
  const [workspaces, setWorkspaces] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 一覧の再取得要求。`workspaceId`を指定すると、そのWorkspaceの個別の状態も同じ時点で取り直す。
  const [refresh, setRefresh] = useState<{ revision: number; workspaceId: string | null }>({ revision: 0, workspaceId: null });
  const [loadedRevision, setLoadedRevision] = useState<number | null>(null);
  const [rememberedId, setRememberedId] = useState(readRemembered);
  // Project配下の画面の所属Workspace（取得できなければnull）と、一覧に無いWorkspaceの個別取得の結果。
  const [projectWorkspaces, setProjectWorkspaces] = useState<Record<string, string | null>>({});
  const [extraWorkspaces, setExtraWorkspaces] = useState<Record<string, Workspace | null>>({});

  const reload = useCallback(() => setRefresh(({ revision }) => ({ revision: revision + 1, workspaceId: null })), []);
  const refreshWorkspace = useCallback((workspaceId: string) => setRefresh(({ revision }) => ({ revision: revision + 1, workspaceId })), []);
  useEffect(() => {
    let active = true;
    const { revision, workspaceId } = refresh;
    setError(null);
    // 一覧と個別の状態は同じrenderで反映し、Selector・Shell・本文が食い違う中間状態を作らない。
    loadWorkspaceNavigation(workspaceId)
      .then(({ workspaces, workspace }) => {
        if (!active) return;
        setWorkspaces(workspaces);
        if (workspaceId !== null) setExtraWorkspaces((map) => ({ ...map, [workspaceId]: workspace }));
      })
      .catch((reason: unknown) => { if (active) setError(loadFailureMessage(classifyError(reason), "Workspaceの一覧が見つかりません。")); })
      .finally(() => { if (active) setLoadedRevision(revision); });
    return () => { active = false; };
  }, [refresh]);

  const projectId = location.kind === "project" ? location.projectId : null;
  useEffect(() => {
    if (projectId === null || projectId in projectWorkspaces) return;
    let active = true;
    request<{ project: Project }>(`/api/projects/${projectId}`)
      .then(({ project }) => project.workspaceId, () => null)
      .then((workspaceId) => { if (active) setProjectWorkspaces((map) => ({ ...map, [projectId]: workspaceId })); });
    return () => { active = false; };
  }, [projectId, projectWorkspaces]);

  const currentId =
    location.kind === "workspace"
      ? location.workspaceId
      : location.kind === "project"
        ? projectWorkspaces[location.projectId] ?? null
        : workspaces?.some(({ id }) => id === rememberedId) ? rememberedId : null;
  const listed = workspaces?.find(({ id }) => id === currentId) ?? null;

  useEffect(() => {
    if (listed === null) return;
    remember(listed.id);
    setRememberedId(listed.id);
  }, [listed]);

  // 一覧に無いWorkspace。別タブ・Project作成で増えたWorkspaceは一覧を取り直し、archived等は個別に取得して名前を出す。
  const missingId = workspaces !== null && currentId !== null && listed === null && !(currentId in extraWorkspaces) ? currentId : null;
  useEffect(() => {
    if (missingId === null) return;
    let active = true;
    request<{ workspace: Workspace }>(`/api/workspaces/${missingId}`)
      .then(({ workspace }) => workspace, () => null)
      .then((workspace) => {
        if (!active) return;
        setExtraWorkspaces((map) => ({ ...map, [missingId]: workspace }));
        if (workspace?.status === "active") reload();
      });
    return () => { active = false; };
  }, [missingId, reload]);

  const current = resolveCurrentWorkspace(workspaces, extraWorkspaces, currentId);
  const listFresh = loadedRevision === refresh.revision;
  const resolving =
    (workspaces === null && error === null) ||
    (location.kind === "project" && !(location.projectId in projectWorkspaces)) ||
    (currentId !== null && listed === null && !(currentId in extraWorkspaces) && error === null);
  const value = useMemo(
    () => ({ workspaces: listFresh ? workspaces : null, error, reload, refreshWorkspace, location, currentId, current, resolving, rememberedId }),
    // locationは毎render作り直すため、内容で比較する。
    [workspaces, listFresh, error, reload, refreshWorkspace, JSON.stringify(location), currentId, current, resolving, rememberedId],
  );
  return <WorkspaceNavigationContext.Provider value={value}>{children}</WorkspaceNavigationContext.Provider>;
};
