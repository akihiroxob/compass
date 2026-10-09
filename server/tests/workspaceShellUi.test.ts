import assert from "node:assert/strict";
import test from "node:test";
import {
  chooseHomeWorkspace,
  currentSection,
  filterWorkspaces,
  parseShellLocation,
  switchWorkspacePath,
  withProjectAccess,
  workspacePath,
  workspaceProjectsPath,
  type Workspace,
  type WorkspaceProject,
} from "../src/web/features/workspace/workspace.ts";

/** Workspace Selector・Shellのナビゲーション（S09-02）。画面の描画・実ブラウザ確認はTaskの結果に記録する。 */

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
  assert.deepEqual(parseShellLocation("/projects/p-1/tasks/t-1"), { kind: "project", projectId: "p-1" });
  assert.deepEqual(parseShellLocation("/projects/new"), { kind: "none" });
  assert.deepEqual(parseShellLocation("/projects"), { kind: "none" });
  assert.deepEqual(parseShellLocation("/"), { kind: "none" });
});

test("Project配下の画面は「Project」を選択中にし、Workspaceの切替は同じ項目（Project配下からはProject一覧）へ移る", () => {
  assert.equal(currentSection({ kind: "project", projectId: "p-1" }), "projects");
  assert.equal(currentSection({ kind: "none" }), null);
  assert.equal(switchWorkspacePath(parseShellLocation("/workspaces/ws-1/direction"), "ws-2"), "/workspaces/ws-2/direction");
  assert.equal(switchWorkspacePath(parseShellLocation("/workspaces/ws-1"), "ws-2"), "/workspaces/ws-2");
  assert.equal(switchWorkspacePath(parseShellLocation("/projects/p-1"), "ws-2"), "/workspaces/ws-2/projects");
  assert.equal(switchWorkspacePath(parseShellLocation("/projects"), "ws-2"), "/workspaces/ws-2");
  assert.equal(workspacePath("ws-1", "activity"), "/workspaces/ws-1/activity");
  assert.equal(workspaceProjectsPath("ws-1"), "/workspaces/ws-1/projects");
  assert.equal(workspaceProjectsPath("ws-1", "archived"), "/workspaces/ws-1/projects?status=archived");
});

test("ホームは前回選択したWorkspaceを、閲覧できなくなっていれば一覧の先頭を開き、参加が無ければnull", () => {
  const list = [workspace("ws-1", "Taneru"), workspace("ws-2", "Petari")];
  assert.equal(chooseHomeWorkspace(list, "ws-2")?.id, "ws-2");
  // Membershipを失った・削除されたWorkspaceは一覧に無いため開かない。
  assert.equal(chooseHomeWorkspace(list, "ws-gone")?.id, "ws-1");
  assert.equal(chooseHomeWorkspace(list, null)?.id, "ws-1");
  assert.equal(chooseHomeWorkspace([], "ws-1"), null);
});

test("Selectorの絞り込みは名前・Missionの部分一致で、空の入力は全件", () => {
  const list = [workspace("ws-1", "Taneru", "子どもが学び続けられる"), workspace("ws-2", "Petari", "小さなチームの共同作業")];
  assert.deepEqual(filterWorkspaces(list, "  ").map(({ id }) => id), ["ws-1", "ws-2"]);
  assert.deepEqual(filterWorkspaces(list, "taneru").map(({ id }) => id), ["ws-1"]);
  assert.deepEqual(filterWorkspaces(list, "チーム").map(({ id }) => id), ["ws-2"]);
  assert.deepEqual(filterWorkspaces(list, "none"), []);
});

test("WorkspaceのProjectは、Project Membershipを持つものだけを開ける（Workspace Membershipから継承しない）", () => {
  const project = (id: string): WorkspaceProject => ({
    id,
    workspaceId: "ws-1",
    name: id,
    description: null,
    repositories: [],
    resources: [],
    createdAt: 1,
    updatedAt: 1,
    status: "active",
    archivedAt: null,
    archiveReason: null,
  });
  assert.deepEqual(
    withProjectAccess([project("p-1"), project("p-2")], new Set(["p-2", "p-other"])).map(({ project, canOpen }) => [project.id, canOpen]),
    [["p-1", false], ["p-2", true]],
  );
});
