// 画面URL・Web API pathの組立て（route契約）。複数Featureが互いの画面へ辿るため共通層に置き、業務判定は置かない。
// テストからも読み込むため、他moduleをimportしない純関数だけを置く。

/** Workspace所有のDirection（Intent・Outcome・Research・Decision・ADR参照・Evaluation）のWeb API。画面のrouteはProject配下のまま。 */
export const workspaceApiPath = (workspaceId: string, suffix = "") => `/api/workspaces/${workspaceId}${suffix}`;

export const intentPath = (projectId: string, intentId?: string, suffix = "") =>
  `/projects/${projectId}/intents${intentId ? `/${intentId}` : ""}${suffix}`;

export const outcomePath = (projectId: string, intentId: string, outcomeId?: string, suffix = "") =>
  `${intentPath(projectId, intentId)}/outcomes${outcomeId ? `/${outcomeId}` : ""}${suffix}`;

export const researchRequestPath = (projectId: string, requestId: string) =>
  `/projects/${projectId}/research/${requestId}`;

/** Project相談の詳細画面。一覧はProject詳細の「判断待ち」view。 */
export const consultationPath = (projectId: string, consultationId: string) => `/projects/${projectId}/consultations/${consultationId}`;

export const taskPath = (projectId: string, taskId: string) => `/projects/${projectId}/tasks/${taskId}`;
export const taskEditPath = (projectId: string, taskId: string) => `${taskPath(projectId, taskId)}/edit`;
export const taskCreatePath = (projectId: string, storyId?: string) =>
  `/projects/${projectId}/tasks/new${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ""}`;
export const storyCreatePath = (projectId: string) => `/projects/${projectId}/stories/new`;
export const storyEditPath = (projectId: string, storyId: string) => `/projects/${projectId}/stories/${storyId}/edit`;

export const workspaceSections = ["overview", "direction", "projects", "activity", "agents", "settings"] as const;
export type WorkspaceSection = (typeof workspaceSections)[number];

/** Workspaceの画面のpath。概要はWorkspaceのpathそのもの。 */
export const workspacePath = (workspaceId: string, section: WorkspaceSection = "overview") =>
  `/workspaces/${workspaceId}${section === "overview" ? "" : `/${section}`}`;

/** Workspaceの作成・編集、既存WorkspaceへのProject追加の画面。 */
export const workspaceCreatePath = "/workspaces/new";
export const workspaceEditPath = (workspaceId: string) => `${workspacePath(workspaceId)}/edit`;
export const workspaceProjectCreatePath = (workspaceId: string) => `${workspacePath(workspaceId, "projects")}/new`;

/** Workspaceの方向のOutcome詳細。Outcomeは所属Intentとともに指す（Web APIのpathと同じ）。 */
export const workspaceOutcomePath = (workspaceId: string, intentId: string, outcomeId: string) =>
  `${workspacePath(workspaceId, "direction")}/intents/${intentId}/outcomes/${outcomeId}`;

/** WorkspaceのProject一覧。activeは既定のためqueryを付けない。 */
export const workspaceProjectsPath = (workspaceId: string, status: "active" | "archived" = "active") =>
  `${workspacePath(workspaceId, "projects")}${status === "archived" ? "?status=archived" : ""}`;

/** Project詳細のview。`?view=`で表し、再読込・共有・戻るで同じviewへ戻る。 */
export const projectViews = ["overview", "direction", "work", "consultations", "records", "settings"] as const;
export type ProjectView = (typeof projectViews)[number];

/** viewのURL。`hash`はview内の要素（Task・Role行など）のid。 */
export const projectViewPath = (projectId: string, view: ProjectView, hash?: string) =>
  `/projects/${projectId}?view=${view}${hash ? `#${hash}` : ""}`;
