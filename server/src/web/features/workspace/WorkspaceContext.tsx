import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import type { Project } from "../../projectForm";
import { parseShellLocation, type ShellLocation, type Workspace } from "./workspace";

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

type WorkspaceNavigation = {
  /** 有効なWorkspace Membershipを持つactiveなWorkspace。権限の無いWorkspaceはserverが返さない。 */
  workspaces: Workspace[] | null;
  error: string | null;
  reload: () => void;
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
  const [revision, setRevision] = useState(0);
  const [rememberedId, setRememberedId] = useState(readRemembered);
  // Project配下の画面の所属Workspace（取得できなければnull）と、一覧に無いWorkspaceの個別取得の結果。
  const [projectWorkspaces, setProjectWorkspaces] = useState<Record<string, string | null>>({});
  const [extraWorkspaces, setExtraWorkspaces] = useState<Record<string, Workspace | null>>({});

  const reload = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let active = true;
    setError(null);
    request<{ workspaces: Workspace[] }>("/api/workspaces")
      .then((body) => { if (active) setWorkspaces(body.workspaces); })
      .catch((reason: unknown) => { if (active) setError(loadFailureMessage(classifyError(reason), "Workspaceの一覧が見つかりません。")); });
    return () => { active = false; };
  }, [revision]);

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

  const current = listed ?? (currentId === null ? null : extraWorkspaces[currentId] ?? null);
  const resolving =
    (workspaces === null && error === null) ||
    (location.kind === "project" && !(location.projectId in projectWorkspaces)) ||
    (currentId !== null && listed === null && !(currentId in extraWorkspaces) && error === null);
  const value = useMemo(
    () => ({ workspaces, error, reload, location, currentId, current, resolving, rememberedId }),
    // locationは毎render作り直すため、内容で比較する。
    [workspaces, error, reload, JSON.stringify(location), currentId, current, resolving, rememberedId],
  );
  return <WorkspaceNavigationContext.Provider value={value}>{children}</WorkspaceNavigationContext.Provider>;
};
