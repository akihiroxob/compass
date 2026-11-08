import assert from "node:assert/strict";
import test from "node:test";
import { emptyFormValues, formValuesFromProject, repositoryNameFromUrl, withDerivedNames, type Project } from "../src/web/features/project/project.ts";
import { emptyWorkspaceFormValues, workspaceFormValues } from "../src/web/features/workspace/workspaceForm.ts";

const project: Project = {
  id: "p1",
  workspaceId: "w1",
  name: "Compass",
  description: null,
  mission: "Mission",
  vision: null,
  principles: ["a", "b"],
  constraints: [],
  repositories: [{ id: "r1", name: "core", url: "https://example.com/core" }],
  resources: [
    { id: "s1", name: "Docs", url: "https://example.com/docs", kind: "docs" },
    { id: "s2", name: "Board", url: "https://example.com/board", kind: null },
  ],
  createdAt: 1,
  updatedAt: 2,
  status: "active",
  archivedAt: null,
  archiveReason: null,
};

test("保存済みProjectから、未設定を空欄・子要素のidを保持した編集フォーム値を作る。Mission等（Workspaceの値）は含めない", () => {
  assert.deepEqual(formValuesFromProject(project), {
    name: "Compass",
    description: "",
    repositories: [{ id: "r1", name: "core", url: "https://example.com/core", kind: "" }],
    resources: [
      { id: "s1", name: "Docs", url: "https://example.com/docs", kind: "docs" },
      { id: "s2", name: "Board", url: "https://example.com/board", kind: "" },
    ],
  });
});

test("編集フォーム値は元のProjectと配列を共有せず、作成フォームの初期値は空", () => {
  const values = formValuesFromProject(project);
  values.resources.push({ name: "added", url: "https://example.com/added", kind: "" });
  assert.equal(project.resources.length, 2);
  assert.equal(emptyFormValues.name, "");
  assert.deepEqual(emptyFormValues.repositories, []);
});

test("Workspaceの編集フォーム値は未設定のVisionを空欄にし、元のWorkspaceと配列を共有しない", () => {
  const workspace = { id: "w1", name: "Petari", mission: "Mission", vision: null, principles: ["a"], constraints: [], createdAt: 1, updatedAt: 1, status: "active" as const, archivedAt: null, archiveReason: null };
  const values = workspaceFormValues(workspace);
  assert.deepEqual(values, { name: "Petari", mission: "Mission", vision: "", principles: ["a"], constraints: [] });
  values.principles.push("changed");
  assert.deepEqual(workspace.principles, ["a"]);
  assert.deepEqual(emptyWorkspaceFormValues, { name: "", mission: "", vision: "", principles: [], constraints: [] });
});

test("Repository URLから表示名を導出する（.git除去・末尾要素・無ければホスト名）", () => {
  assert.equal(repositoryNameFromUrl("https://github.com/akihiroxob/compass.git"), "compass");
  assert.equal(repositoryNameFromUrl("https://github.com/akihiroxob/compass/"), "compass");
  assert.equal(repositoryNameFromUrl("https://example.com"), "example.com");
});

test("編集の保存では手入力の名前を使わず、各RepositoryのURLから表示名を導き、idを保持する", () => {
  assert.deepEqual(
    withDerivedNames([
      { id: "r1", name: "古い名前", url: " https://example.com/acme/core.git ", kind: "" },
      { name: "", url: "", kind: "" },
    ]),
    [
      { id: "r1", name: "core", url: "https://example.com/acme/core.git", kind: "" },
      { name: "Repository", url: "", kind: "" },
    ],
  );
});
