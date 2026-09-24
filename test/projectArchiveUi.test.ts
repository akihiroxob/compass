import assert from "node:assert/strict";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/container.ts";
import { classifyError, request } from "../src/frontend/api.ts";
import type { Project } from "../src/frontend/projectForm.ts";
import {
  archiveInit,
  archiveProjectPath,
  describeArchiveFailure,
  parseListStatus,
  projectListPath,
  projectsApiPath,
  summarizeReason,
  validateArchiveReason,
} from "../src/frontend/projectArchive.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const app = await createSignedInApp(database, createApplicationServices(database));
  // フロントのrequest adapterを、実際のWeb API（同一のapplication層）へ向ける。
  const fetchImpl = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init));
  return { database, app, fetchImpl };
};

const createProject = async (app: App, name: string) => {
  const response = await app.request("/api/projects", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, mission: "Mission" }),
  });
  return ((await response.json()) as { project: Project }).project;
};

const rejection = async (run: () => Promise<unknown>) => {
  try {
    await run();
  } catch (error) {
    return error;
  }
  assert.fail("should reject");
};

test("一覧の切替: statusの解釈とpath・queryを生成する", () => {
  assert.equal(parseListStatus(null), "active");
  assert.equal(parseListStatus("archived"), "archived");
  assert.equal(parseListStatus("all"), "active");
  assert.equal(projectsApiPath("active"), "/api/projects");
  assert.equal(projectsApiPath("archived"), "/api/projects?status=archived");
  assert.equal(projectListPath("active"), "/");
  assert.equal(projectListPath("archived"), "/?status=archived");
});

test("archiveの入力検証: 理由は必須（空白のみも不可）で2,000文字まで", () => {
  assert.equal(validateArchiveReason(""), "アーカイブの理由を入力してください。");
  assert.equal(validateArchiveReason("  \n "), "アーカイブの理由を入力してください。");
  assert.equal(validateArchiveReason("役目を終えた"), null);
  assert.equal(validateArchiveReason("あ".repeat(2_000)), null);
  assert.match(validateArchiveReason("あ".repeat(2_001)) ?? "", /2000文字以内/);
});

test("archiveのrequestはPOSTで、本文はreasonのみ", () => {
  assert.equal(archiveProjectPath("p1"), "/api/projects/p1/archive");
  const init = archiveInit("終了");
  assert.equal(init.method, "POST");
  assert.deepEqual(JSON.parse(init.body as string), { reason: "終了" });
});

test("理由の要約: 改行を畳み、長い理由を省略する", () => {
  assert.equal(summarizeReason(null), "");
  assert.equal(summarizeReason("a\n  b"), "a b");
  assert.equal(summarizeReason("x".repeat(90)), `${"x".repeat(80)}…`);
});

test("archiveの失敗表示: 400（理由）・409（archived）・404を区別して整形する", async () => {
  const { database, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");

  const empty = classifyError(await rejection(() => request(archiveProjectPath(project.id), archiveInit("   "), fetchImpl)));
  assert.equal(empty.kind, "validation");
  assert.match(describeArchiveFailure(empty), /^アーカイブの理由: /);

  const archived = await request<{ project: Project }>(archiveProjectPath(project.id), archiveInit("役目を終えた"), fetchImpl);
  assert.equal(archived.project.status, "archived");
  assert.equal(archived.project.archiveReason, "役目を終えた");
  assert.equal(typeof archived.project.archivedAt, "number");

  const again = classifyError(await rejection(() => request(archiveProjectPath(project.id), archiveInit("再度"), fetchImpl)));
  assert.deepEqual(again, { kind: "project_archived", message: "アーカイブ済みのため変更できません。" });
  assert.equal(describeArchiveFailure(again), "アーカイブ済みのため変更できません。");

  const missing = classifyError(await rejection(() => request(archiveProjectPath("missing"), archiveInit("x"), fetchImpl)));
  assert.equal(describeArchiveFailure(missing), "Projectが見つかりません。");
  await database.destroy();
});

test("archived Projectへの保存はproject_archivedとして分類され、Intentの競合（conflict）とは区別される", async () => {
  const { database, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  const patch = (name: string): RequestInit => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
  const intentInit: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", desiredState: "S" }) };

  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);

  for (const run of [
    () => request(`/api/projects/${project.id}`, patch("Changed"), fetchImpl),
    () => request(`/api/projects/${project.id}/intents`, intentInit, fetchImpl),
    () => request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId: "agent", role: "strategist" }) }, fetchImpl),
  ]) {
    assert.equal(classifyError(await rejection(run)).kind, "project_archived");
  }
  // 保存済みの内容は変わらず、詳細は参照できる。
  const detail = await request<{ project: Project }>(`/api/projects/${project.id}`, undefined, fetchImpl);
  assert.equal(detail.project.name, "Compass");
  assert.equal(detail.project.status, "archived");
  await database.destroy();
});

test("一覧: 通常はactiveのみ、?status=archivedでarchivedのみ（理由・日時つき）を取得できる", async () => {
  const { database, app, fetchImpl } = await setup();
  const active = await createProject(app, "Active project");
  const toArchive = await createProject(app, "Archived project");
  await request(archiveProjectPath(toArchive.id), archiveInit("終了"), fetchImpl);

  const normal = await request<{ projects: Project[] }>(projectsApiPath("active"), undefined, fetchImpl);
  assert.deepEqual(normal.projects.map((project) => project.id), [active.id]);

  const archivedList = await request<{ projects: Project[] }>(projectsApiPath("archived"), undefined, fetchImpl);
  assert.deepEqual(archivedList.projects.map((project) => project.id), [toArchive.id]);
  assert.equal(archivedList.projects[0]?.archiveReason, "終了");
  assert.equal(typeof archivedList.projects[0]?.archivedAt, "number");
  await database.destroy();
});
