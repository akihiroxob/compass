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
import { chooseHomeWorkspace, resolveCurrentWorkspace, type Workspace } from "../src/web/features/workspace/workspace.ts";
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

type WorkspaceNavigationState = { workspaces: Workspace[]; workspace: Workspace | null };

/** Shellと同じ経路で、Workspace一覧と現在のWorkspaceの状態を同じ時点で取得する（Projectのarchive後の再取得）。 */
const loadWorkspaceNavigation = async (workspaceId: string, fetchImpl: FetchLike): Promise<WorkspaceNavigationState> => {
  const web = register({ namespace: "project-archive-ui-navigation", tsconfig: fileURLToPath(new URL("../src/web/tsconfig.json", import.meta.url)) });
  try {
    const module = await web.import("../src/web/features/workspace/WorkspaceContext.tsx", import.meta.url) as {
      loadWorkspaceNavigation: (workspaceId: string, fetchImpl: FetchLike) => Promise<WorkspaceNavigationState>;
    };
    return await module.loadWorkspaceNavigation(workspaceId, fetchImpl);
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

/** Workspace ownerとしてWorkspaceをarchiveする（Projectのarchiveとは別の操作）。 */
const archiveWorkspace = (workspaceId: string, fetchImpl: FetchLike) => request(`/api/workspaces/${workspaceId}/archive`, archiveInit("終了"), fetchImpl);

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
  // Projectのarchiveでは所属WorkspaceのDirectionを書き込める。WorkspaceのarchiveはWorkspace ownerの別操作。
  await request(`/api/workspaces/${project.workspaceId}/intents`, intentInit, fetchImpl);
  await archiveWorkspace(project.workspaceId, fetchImpl);

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

test("archive後の再取得: 単独ProjectのarchiveではWorkspaceはactiveのままで、Workspaceのarchiveで初めてDirectionの変更導線を閉じる", async () => {
  const { database, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  assert.deepEqual(await loadProjectWorkspaceDirection(project.id, fetchImpl), { access: "allowed", workspaceId: project.workspaceId });

  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);
  assert.deepEqual(await loadProjectWorkspaceDirection(project.id, fetchImpl), { access: "allowed", workspaceId: project.workspaceId });
  await archiveWorkspace(project.workspaceId, fetchImpl);
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

test("archive後のShell: 最後のactive ProjectのarchiveではWorkspaceは一覧に残り、Workspaceのarchiveで一覧から外れ、現在のWorkspaceはarchived、ホームは選ばない", async () => {
  const { database, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  const other = await createProject(app, "Other");
  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);
  const before = await loadWorkspaceNavigation(project.workspaceId, fetchImpl);
  assert.ok(before.workspaces.some(({ id }) => id === project.workspaceId));
  assert.equal(before.workspace?.status, "active");

  await archiveWorkspace(project.workspaceId, fetchImpl);
  const after = await loadWorkspaceNavigation(project.workspaceId, fetchImpl);
  assert.deepEqual(after.workspaces.map(({ id }) => id), [other.workspaceId]);
  assert.equal(after.workspace?.status, "archived");
  // 再取得前に一覧から得ていた古いactiveの状態は使わず、個別に取得した状態（archived）を表示する。
  const stale = { [project.workspaceId]: before.workspaces.find(({ id }) => id === project.workspaceId) ?? null };
  assert.equal(resolveCurrentWorkspace(after.workspaces, { ...stale, [project.workspaceId]: after.workspace }, project.workspaceId)?.status, "archived");
  // 前回選択がarchiveされたWorkspaceでも、ホームはactiveな一覧から選ぶ。
  assert.equal(chooseHomeWorkspace(after.workspaces, project.workspaceId)?.id, other.workspaceId);
  await database.destroy();
});

test("archive後のShell: 他のactive Projectが残るWorkspaceは一覧に残り、activeのまま表示する", async () => {
  const { database, services, app, fetchImpl } = await setup();
  const project = await createProject(app, "Compass");
  await services.human.createWorkspaceProject.execute({ kind: "human", humanUserId: app.human.humanUserId }, project.workspaceId, { name: "Sibling" });

  await request(archiveProjectPath(project.id), archiveInit("終了"), fetchImpl);
  const after = await loadWorkspaceNavigation(project.workspaceId, fetchImpl);
  assert.ok(after.workspaces.some(({ id }) => id === project.workspaceId));
  assert.equal(after.workspace?.status, "active");
  assert.equal(resolveCurrentWorkspace(after.workspaces, { [project.workspaceId]: after.workspace }, project.workspaceId)?.status, "active");
  assert.equal(chooseHomeWorkspace(after.workspaces, project.workspaceId)?.id, project.workspaceId);
  await database.destroy();
});
