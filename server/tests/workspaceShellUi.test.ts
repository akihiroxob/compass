import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseHomeWorkspace,
  currentSection,
  parseShellLocation,
  resolveCurrentWorkspace,
  workspaceMenuSections,
  workspaceSectionLabels,
  type Workspace,
} from "../src/web/features/workspace/workspace.ts";
import { projectViewLabels } from "../src/web/features/project/overview.ts";
import { projectMenuViews, projectViewPath, workspaceCreatePath, workspaceEditPath, workspaceOutcomePath, workspacePath, workspaceProjectCreatePath, workspaceProjectsPath } from "../src/web/paths.ts";

/** Workspace Selector・Shellのメニュー。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

const workspace = (id: string, name: string, mission = `${name}のMission`): Workspace => ({
  id,
  name,
  mission,
  vision: null,
  principles: [],
  constraints: [],
  createdAt: 1,
  updatedAt: 1,
  status: "active",
  archivedAt: null,
  archiveReason: null,
});

test("現在位置はURLだけから読み、深いURLの再読込でも同じWorkspace・項目へ戻る", () => {
  assert.deepEqual(parseShellLocation("/workspaces/ws-1"), { kind: "workspace", workspaceId: "ws-1", section: "overview" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/direction"), { kind: "workspace", workspaceId: "ws-1", section: "direction" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/projects"), { kind: "workspace", workspaceId: "ws-1", section: "projects" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/agents/"), { kind: "workspace", workspaceId: "ws-1", section: "agents" });
  // 定義していない項目（未定義のURL）はナビゲーションの選択にしない。
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/overview"), { kind: "workspace", workspaceId: "ws-1", section: null });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/activity/x"), { kind: "workspace", workspaceId: "ws-1", section: null });
  assert.deepEqual(parseShellLocation("/projects/p-1/tasks/t-1"), { kind: "project", projectId: "p-1", view: "work" });
  assert.deepEqual(parseShellLocation("/projects/new"), { kind: "none" });
  // Workspaceの作成は特定のWorkspaceではない。編集は「概要」、Project追加は「Project」の項目に属する。
  assert.deepEqual(parseShellLocation("/workspaces/new"), { kind: "none" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/edit"), { kind: "workspace", workspaceId: "ws-1", section: "overview" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/projects/new"), { kind: "workspace", workspaceId: "ws-1", section: "projects" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/edit/x"), { kind: "workspace", workspaceId: "ws-1", section: null });
  // WorkspaceのOutcome詳細は「方向」に属する。Outcomeまで揃わないURLは選択にしない。
  assert.deepEqual(parseShellLocation(workspaceOutcomePath("ws-1", "i-1", "o-1")), { kind: "workspace", workspaceId: "ws-1", section: "direction" });
  assert.deepEqual(parseShellLocation("/workspaces/ws-1/direction/intents/i-1"), { kind: "workspace", workspaceId: "ws-1", section: null });
  assert.deepEqual(parseShellLocation("/projects"), { kind: "none" });
  assert.deepEqual(parseShellLocation("/"), { kind: "none" });
});

test("メニューは概要→対応待ち→Outcome→Activity→Agent管理→設定、Projectの階層は概要・開発詳細・リリース履歴・設定", () => {
  assert.deepEqual(workspaceMenuSections.map((section) => workspaceSectionLabels[section]), ["概要", "対応待ち", "Outcome", "Activity", "Agent管理", "設定"]);
  assert.deepEqual(projectMenuViews.map((view) => projectViewLabels[view]), ["概要", "開発詳細", "リリース履歴", "設定"]);
});

test("Project配下の画面はWorkspaceの項目を選択せず、Projectの階層のviewを選択中にする", () => {
  assert.equal(currentSection(parseShellLocation("/projects/p-1")), null);
  assert.equal(currentSection({ kind: "none" }), null);
  assert.deepEqual(parseShellLocation("/projects/p-1"), { kind: "project", projectId: "p-1", view: "overview" });
  assert.deepEqual(parseShellLocation("/projects/p-1", "?view=work"), { kind: "project", projectId: "p-1", view: "work" });
  assert.deepEqual(parseShellLocation("/projects/p-1", "?view=releases"), { kind: "project", projectId: "p-1", view: "releases" });
  // 不正な値は概要（Project詳細の表示と同じ）。メニューに無いview・画面はどのviewも選択しない。
  assert.deepEqual(parseShellLocation("/projects/p-1", "?view=unknown"), { kind: "project", projectId: "p-1", view: "overview" });
  assert.deepEqual(parseShellLocation("/projects/p-1", "?view=records"), { kind: "project", projectId: "p-1", view: null });
  assert.deepEqual(parseShellLocation("/projects/p-1/intents/i-1"), { kind: "project", projectId: "p-1", view: null });
  // Projectの編集は「設定」、Story・Taskの作成・編集は「開発詳細」。
  assert.deepEqual(parseShellLocation("/projects/p-1/edit"), { kind: "project", projectId: "p-1", view: "settings" });
  assert.deepEqual(parseShellLocation("/projects/p-1/stories/new"), { kind: "project", projectId: "p-1", view: "work" });
});

test("Workspace・Projectの切替先は対象の概要", () => {
  // 切替は元の画面の項目・viewを持ち越さない（WorkspaceSwitcher・WorkspaceProjectNavが使うpath）。
  assert.equal(workspacePath("ws-2"), "/workspaces/ws-2");
  assert.equal(projectViewPath("p-2", "overview"), "/projects/p-2?view=overview");
  assert.equal(workspacePath("ws-1", "activity"), "/workspaces/ws-1/activity");
  assert.equal(workspaceProjectsPath("ws-1"), "/workspaces/ws-1/projects");
  assert.equal(workspaceProjectsPath("ws-1", "archived"), "/workspaces/ws-1/projects?status=archived");
  assert.equal(workspaceCreatePath, "/workspaces/new");
  assert.equal(workspaceEditPath("ws-1"), "/workspaces/ws-1/edit");
  assert.equal(workspaceProjectCreatePath("ws-1"), "/workspaces/ws-1/projects/new");
});

test("ホームは前回選択したWorkspaceを、閲覧できなくなっていれば一覧の先頭を開き、参加が無ければnull", () => {
  const list = [workspace("ws-1", "Taneru"), workspace("ws-2", "Petari")];
  assert.equal(chooseHomeWorkspace(list, "ws-2")?.id, "ws-2");
  // Membershipを失った・削除されたWorkspaceは一覧に無いため開かない。
  assert.equal(chooseHomeWorkspace(list, "ws-gone")?.id, "ws-1");
  assert.equal(chooseHomeWorkspace(list, null)?.id, "ws-1");
  assert.equal(chooseHomeWorkspace([], "ws-1"), null);
});

test("現在のWorkspaceは一覧（active）を優先し、一覧に無ければ個別に取得した状態、閲覧できなければnull", () => {
  const taneru = workspace("ws-1", "Taneru");
  const archived: Workspace = { ...taneru, status: "archived", archivedAt: 2, archiveReason: "終了" };
  assert.equal(resolveCurrentWorkspace([taneru], {}, "ws-1"), taneru);
  assert.equal(resolveCurrentWorkspace([], { "ws-1": archived }, "ws-1")?.status, "archived");
  assert.equal(resolveCurrentWorkspace([], { "ws-1": null }, "ws-1"), null);
  assert.equal(resolveCurrentWorkspace(null, {}, "ws-1"), null);
  assert.equal(resolveCurrentWorkspace([taneru], {}, null), null);
});
