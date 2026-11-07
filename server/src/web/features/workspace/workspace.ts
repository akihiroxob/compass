// Workspace Selector・Shellのメニュー。現在位置はURLだけで表し、再読込・共有・戻るで同じ画面へ戻る。
// テストからも読み込むため、純関数のmodule以外をimportしない。Workspaceの画面のpathは`paths.ts`。
import { projectMenuViews, projectViews, workspaceSections, type ProjectMenuView, type WorkspaceSection } from "../../paths.ts";

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

export const workspaceSectionLabels: Record<WorkspaceSection, string> = {
  overview: "概要",
  consultations: "対応待ち",
  direction: "Outcome",
  projects: "Project",
  activity: "Activity",
  agents: "Agent管理",
  settings: "設定",
};

/** Workspaceのメニューの項目と順序。Projectはメニューの「Project」の階層から開く（一覧の画面は各画面の導線から開く）。 */
export const workspaceMenuSections = ["overview", "consultations", "direction", "activity", "agents", "settings"] as const satisfies readonly WorkspaceSection[];

/**
 * URLから現在位置を読む。Workspaceの画面はWorkspace IDと項目、Project配下の画面はProject ID（所属Workspaceは取得して解決する）と、
 * メニューのProjectの階層で選択中にするview。
 * Workspaceの編集は「概要」、Project追加は「Project」、Outcome詳細は「方向（Outcome）」、相談詳細は「対応待ち」の項目に属する。
 * Projectの編集は「設定」、Story・Taskの画面は「開発詳細」に属する。
 * それ以外（ホーム・参加中のProject・Workspace作成・未定義のURL）は`none`。
 */
export type ShellLocation =
  | { kind: "workspace"; workspaceId: string; section: WorkspaceSection | null }
  | { kind: "project"; projectId: string; view: ProjectMenuView | null }
  | { kind: "none" };

const projectMenuView = (rest: string | undefined, more: readonly string[], search: string): ProjectMenuView | null => {
  if (rest === undefined) {
    // Project詳細の`?view=`。指定無し・不正な値は概要（Project詳細の表示と同じ）。
    const value = new URLSearchParams(search).get("view");
    const view = projectViews.find((candidate) => candidate === value) ?? "overview";
    return projectMenuViews.find((candidate) => candidate === view) ?? null;
  }
  if (rest === "edit" && more.length === 0) return "settings";
  if (rest === "tasks" || rest === "stories") return "work";
  return null;
};

export const parseShellLocation = (pathname: string, search = ""): ShellLocation => {
  const [first, id, rest, ...more] = pathname.split("/").filter((segment) => segment !== "");
  // `/workspaces/new`はWorkspaceではない（作成画面）。
  if (first === "workspaces" && id && id !== "new") {
    const subPage = more.join("/");
    const section =
      rest === undefined || (rest === "edit" && subPage === "")
        ? "overview"
        : rest === "projects" && subPage === "new"
          ? "projects"
          : rest === "direction" && /^intents\/[^/]+\/outcomes\/[^/]+$/.test(subPage)
            ? "direction"
          : rest === "consultations" && /^[^/]+$/.test(subPage)
            ? "consultations"
          : rest === "agents" && /^[^/]+$/.test(subPage)
            ? "agents"
          : subPage === "" ? workspaceSections.find((value) => value === rest && value !== "overview") ?? null : null;
    return { kind: "workspace", workspaceId: id, section };
  }
  // `/projects/new`はProjectではない（作成画面）。
  if (first === "projects" && id && id !== "new") return { kind: "project", projectId: id, view: projectMenuView(rest, more, search) };
  return { kind: "none" };
};

/** 現在位置に対応するWorkspaceのメニューの項目。Project配下の画面はメニューの「Project」の階層で示すため、項目を選択しない。 */
export const currentSection = (location: ShellLocation): WorkspaceSection | null =>
  location.kind === "workspace" ? location.section : null;

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
