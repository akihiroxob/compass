import assert from "node:assert/strict";
import test from "node:test";
import { emptyFormValues, formValuesFromProject, type Project } from "../src/frontend/projectForm.ts";

const project: Project = {
  id: "p1",
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

test("保存済みProjectから、未設定を空欄・子要素のidを保持した編集フォーム値を作る", () => {
  assert.deepEqual(formValuesFromProject(project), {
    name: "Compass",
    description: "",
    mission: "Mission",
    vision: "",
    principles: ["a", "b"],
    constraints: [],
    repositories: [{ id: "r1", name: "core", url: "https://example.com/core", kind: "" }],
    resources: [
      { id: "s1", name: "Docs", url: "https://example.com/docs", kind: "docs" },
      { id: "s2", name: "Board", url: "https://example.com/board", kind: "" },
    ],
  });
});

test("編集フォーム値は元のProjectと配列を共有せず、作成フォームの初期値は空", () => {
  const values = formValuesFromProject(project);
  values.principles.push("changed");
  assert.deepEqual(project.principles, ["a", "b"]);
  assert.equal(emptyFormValues.name, "");
  assert.deepEqual(emptyFormValues.repositories, []);
});
