import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { register } from "tsx/esm/api";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { createApplicationServices } from "../src/bootstrap/container.ts";
import { classifyError, request } from "../src/web/api.ts";
import type { Project } from "../src/web/projectForm.ts";
import {
  archiveInit,
  archiveProjectPath,
  describeArchiveFailure,
  parseListStatus,
  projectListPath,
  projectsApiPath,
  summarizeReason,
  validateArchiveReason,
} from "../src/web/projectArchive.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";

type App = ReturnType<typeof createApp>;
type FetchLike = (path: string, init?: RequestInit) => Promise<Response>;
type WorkspaceDirectionState = { access: string; workspaceId: string | null };

/** Web用tsconfig（拡張子なしのimport）のmoduleを読み込み、Project画面と同じ判定でWorkspaceのDirectionの状態を取得する。 */
const loadProjectWorkspaceDirection = async (projectId: string, fetchImpl: FetchLike): Promise<WorkspaceDirectionState> => {
  const web = register({ namespace: "project-archive-ui", tsconfig: fileURLToPath(new URL("../src/web/tsconfig.json", import.meta.url)) });
  try {
    const module = await web.import("../src/web/useWorkspaceDirection.ts", import.meta.url) as {
      loadProjectWorkspaceDirection: (projectId: string, fetchImpl: FetchLike) => Promise<WorkspaceDirectionState>;
    };
    return await module.loadProjectWorkspaceDirection(projectId, fetchImpl);
  } finally { await web.unregister(); }
};

const setup = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const app = await createSignedInApp(database, services);
  // フロントのrequest adapterを、実際のWeb API（同一のapplication層）へ向ける。
  const fetchImpl = (path: string, init?: RequestInit) => Promise.resolve(app.request(path, init));
  return { database, services, app, fetchImpl };
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
  assert.equal(projectListPath("active"), "/projects");
  assert.equal(projectListPath("archived"), "/projects?status=archived");
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
    () => request(`/api/workspaces/${project.workspaceId}/intents`, intentInit, fetchImpl),
    () => request(`/api/projects/${project.id}/grants`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ principalId: "agent", role: "manager" }) }, fetchImpl),
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

test("archive後の再取得: 単独ProjectのarchiveでWorkspaceもarchivedとなり、Directionの変更導線を閉じる", async () => {
  const { database, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  assert.deepEqual(await loadProjectWorkspaceDirection(project.id, fetchImpl), { access: "allowed", workspaceId: project.workspaceId });

  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);
  assert.deepEqual(await loadProjectWorkspaceDirection(project.id, fetchImpl), { access: "archived", workspaceId: project.workspaceId });
  await database.destroy();
});

test("archive後の再取得: 他のactive Projectが残るWorkspaceは、Project archived後もWorkspace Membershipに従いDirectionを変更できる", async () => {
  const { database, services, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  await services.human.createWorkspaceProject.execute({ kind: "human", humanUserId: app.human.humanUserId }, project.workspaceId, { name: "Sibling" });

  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);
  const detail = await request<{ project: Project }>(`/api/projects/${project.id}`, undefined, fetchImpl);
  assert.equal(detail.project.status, "archived");
  // Project.statusだけで一律に禁止しない。判定はWorkspaceのstatusとWorkspace Membershipで行う。
  assert.deepEqual(await loadProjectWorkspaceDirection(project.id, fetchImpl), { access: "allowed", workspaceId: project.workspaceId });
  const intentInit: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ title: "T", desiredState: "S" }) };
  const created = await request<{ intent: { workspaceId: string } }>(`/api/workspaces/${project.workspaceId}/intents`, intentInit, fetchImpl);
  assert.equal(created.intent.workspaceId, project.workspaceId);
  await database.destroy();
});
