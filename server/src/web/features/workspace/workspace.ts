// Workspace Selector・Shellのナビゲーション（S09-02）。現在位置はURLだけで表し、再読込・共有・戻るで同じ画面へ戻る。
// テストからも読み込むため、他moduleをimportしない純関数だけを置く。

/** Web API `GET /api/workspaces`・`GET /api/workspaces/:workspaceId`のWorkspace。 */
export type Workspace = {
  id: string;
  name: string;
  mission: string;
  vision: string | null;
  principles: string[];
  constraints: string[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  archivedAt: number | null;
  archiveReason: string | null;
};

/** Web API `GET /api/workspaces/:workspaceId/projects`のProject。Mission等の戦略値はWorkspaceが持つ。 */
export type WorkspaceProject = {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  repositories: { id: string; name: string; url: string }[];
  resources: { id: string; name: string; url: string; kind: string | null }[];
  createdAt: number;
  updatedAt: number;
  status: "active" | "archived";
  archivedAt: number | null;
  archiveReason: string | null;
};

export const workspaceSections = ["overview", "direction", "projects", "activity", "agents"] as const;
export type WorkspaceSection = (typeof workspaceSections)[number];
export const workspaceSectionLabels: Record<WorkspaceSection, string> = {
  overview: "概要",
  direction: "方向",
  projects: "Project",
  activity: "記録",
  agents: "Agent",
};

/** Workspaceの画面のpath。概要はWorkspaceのpathそのもの。 */
export const workspacePath = (workspaceId: string, section: WorkspaceSection = "overview") =>
  `/workspaces/${workspaceId}${section === "overview" ? "" : `/${section}`}`;

/** Workspaceの作成・編集、既存WorkspaceへのProject追加の画面。 */
export const workspaceCreatePath = "/workspaces/new";
export const workspaceEditPath = (workspaceId: string) => `${workspacePath(workspaceId)}/edit`;
export const workspaceProjectCreatePath = (workspaceId: string) => `${workspacePath(workspaceId, "projects")}/new`;

/** WorkspaceのProject一覧。activeは既定のためqueryを付けない。 */
export const workspaceProjectsPath = (workspaceId: string, status: "active" | "archived" = "active") =>
  `${workspacePath(workspaceId, "projects")}${status === "archived" ? "?status=archived" : ""}`;

/**
 * URLから現在位置を読む。Workspaceの画面はWorkspace IDと項目、Project配下の画面はProject ID（所属Workspaceは取得して解決する）。
 * Workspaceの編集は「概要」、Project追加は「Project」の項目に属する。
 * それ以外（ホーム・参加中のProject・Workspace作成・未定義のURL）は`none`。
 */
export type ShellLocation =
  | { kind: "workspace"; workspaceId: string; section: WorkspaceSection | null }
  | { kind: "project"; projectId: string }
  | { kind: "none" };

export const parseShellLocation = (pathname: string): ShellLocation => {
  const [first, id, rest, ...more] = pathname.split("/").filter((segment) => segment !== "");
  // `/workspaces/new`はWorkspaceではない（作成画面）。
  if (first === "workspaces" && id && id !== "new") {
    const subPage = more.join("/");
    const section =
      rest === undefined || (rest === "edit" && subPage === "")
        ? "overview"
        : rest === "projects" && subPage === "new"
          ? "projects"
          : subPage === "" ? workspaceSections.find((value) => value === rest && value !== "overview") ?? null : null;
    return { kind: "workspace", workspaceId: id, section };
  }
  // `/projects/new`はProjectではない（作成画面）。
  if (first === "projects" && id && id !== "new") return { kind: "project", projectId: id };
  return { kind: "none" };
};

/** 現在位置に対応するナビゲーション項目。Project配下の画面は「Project」。 */
export const currentSection = (location: ShellLocation): WorkspaceSection | null =>
  location.kind === "workspace" ? location.section : location.kind === "project" ? "projects" : null;

/** Workspaceを切り替えた先。同じ項目を開き、Project配下からはProject一覧へ移る。 */
export const switchWorkspacePath = (location: ShellLocation, workspaceId: string) =>
  workspacePath(workspaceId, currentSection(location) ?? "overview");

/**
 * 現在のWorkspace。一覧（activeのみ）にあればそれ、無ければ個別に取得した状態（archived等。閲覧できなければnull）。
 * 一覧から外れたWorkspaceは個別の状態で表示し、古いactiveの状態を残さない。
 */
export const resolveCurrentWorkspace = (
  workspaces: readonly Workspace[] | null,
  fetched: Readonly<Record<string, Workspace | null>>,
  currentId: string | null,
): Workspace | null => (currentId === null ? null : workspaces?.find(({ id }) => id === currentId) ?? fetched[currentId] ?? null);

/** ホームで開くWorkspace。前回選択したWorkspaceが今も閲覧できればそれ、無ければ一覧の先頭（更新日時の降順）。 */
export const chooseHomeWorkspace = (workspaces: readonly Workspace[], rememberedId: string | null): Workspace | null =>
  workspaces.find(({ id }) => id === rememberedId) ?? workspaces[0] ?? null;

/** Selectorの絞り込み。名前・Missionの部分一致（大文字小文字を区別しない）。 */
export const filterWorkspaces = (workspaces: readonly Workspace[], query: string): Workspace[] => {
  const needle = query.trim().toLocaleLowerCase();
  if (needle === "") return [...workspaces];
  return workspaces.filter(({ name, mission }) => `${name}\n${mission}`.toLocaleLowerCase().includes(needle));
};

/**
 * WorkspaceのProjectに、開けるかを付ける。Project詳細はProject Membershipで認可され、Workspace Membershipから継承しない。
 * `memberProjectIds`はHumanがMembershipを持つProject（`GET /api/projects`）。
 */
export const withProjectAccess = (projects: readonly WorkspaceProject[], memberProjectIds: ReadonlySet<string>) =>
  projects.map((project) => ({ project, canOpen: memberProjectIds.has(project.id) }));
