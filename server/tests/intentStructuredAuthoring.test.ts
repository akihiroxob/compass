import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HumanActor } from "@compass/access";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestWorkspaceMembership, createTestHuman, requestAs, type TestHuman } from "./support/humanSession.ts";

/**
 * 構造化したIntent（ビジネス目標）を、Workspace EditorのWeb UI（Web API）と、WorkspaceのStrategistの公開MCP（remote mode・
 * 発行済みAgent Credential）から登録・更新する。両入口は同じレコードと入力規則を使い、同じDB fileの再起動後も全項目を保持する。
 * Worker・Reviewer・別WorkspaceのCredentialは拒否し、Agentの操作はAgent（Strategist）として記録する。
 */

type App = ReturnType<typeof createApp>;
type Json = Record<string, any>;

const actorOf = (human: TestHuman): HumanActor => ({ kind: "human", humanUserId: human.humanUserId });
const json = { "Content-Type": "application/json" };

const fullInput = {
  title: "売上を月30万円へ",
  desiredState: "継続的な運営を支えるため、月間売上30万円を実現する。",
  background: "学習体験を継続して提供できる売上基盤をつくりたい。",
  audience: "無料体験から有料利用を検討する人。",
  constraints: "短期的な売上のために、学習体験や継続率を損なわない。",
  completionDefinition: "対象月の売上が30万円以上になったことを、売上データで確認できる。",
  targetDate: "2027-03-31",
};
const structuredKeys = Object.keys(fullInput) as (keyof typeof fullInput)[];
const pick = (intent: Json) => Object.fromEntries(structuredKeys.map((key) => [key, intent[key]]));

const open = async (path: string) => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database);
  const webApp = createApp(services);
  const remoteApp = createApp(services, { humanAuth: { mode: "remote", publicOrigin: "https://compass.example" } });
  return { database, services, webApp, remoteApp };
};

let rpcId = 0;
const callTool = async (app: App, token: string, name: string, args: object, activeRole?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      ...json,
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result as { isError?: boolean; structuredContent: Json };
};

const issueAgentToken = async (app: App, owner: TestHuman, path: string, principalId: string) => {
  const response = await requestAs(app, owner)(path, { method: "POST", headers: json, body: JSON.stringify({ kind: "agent", principalId }) });
  assert.equal(response.status, 201, await response.clone().text());
  return ((await response.json()) as { token: string }).token;
};

/** Owner・Editorと、Workspace A（Project A）・B、AのStrategist・Worker・Reviewer、BのStrategistのAgent Credentialを公開操作で用意する。 */
const prepare = async (kit: Awaited<ReturnType<typeof open>>) => {
  const { database, services, webApp } = kit;
  const owner = await createTestHuman(database);
  const editor = await createTestHuman(database);
  const workspace = await services.human.createWorkspace.execute({ name: "Alpha", mission: "M" }, actorOf(owner));
  const other = await services.human.createWorkspace.execute({ name: "Beta", mission: "M" }, actorOf(owner));
  const project = await services.human.createWorkspaceProject.execute(actorOf(owner), workspace.id, { name: "Alpha app" });
  await addTestWorkspaceMembership(database, workspace.id, editor, "editor");
  const grant = async (path: string, principalId: string, role: string) => {
    const response = await requestAs(webApp, owner)(path, { method: "POST", headers: json, body: JSON.stringify({ principalId, role }) });
    assert.equal(response.status, 201, principalId);
  };
  await grant(`/api/workspaces/${workspace.id}/grants`, "strategist-a", "strategist");
  await grant(`/api/workspaces/${other.id}/grants`, "strategist-b", "strategist");
  await grant(`/api/projects/${project.id}/grants`, "worker-a", "worker");
  await grant(`/api/projects/${project.id}/grants`, "reviewer-a", "reviewer");
  const tokens = {
    strategist: await issueAgentToken(webApp, owner, `/api/workspaces/${workspace.id}/credentials`, "strategist-a"),
    otherStrategist: await issueAgentToken(webApp, owner, `/api/workspaces/${other.id}/credentials`, "strategist-b"),
    worker: await issueAgentToken(webApp, owner, `/api/projects/${project.id}/credentials`, "worker-a"),
    reviewer: await issueAgentToken(webApp, owner, `/api/projects/${project.id}/credentials`, "reviewer-a"),
  };
  return { owner, editor, workspace, other, project, tokens };
};

test("Workspace EditorのWeb APIとStrategistの公開MCPが同じ構造化Intentを登録・更新し、同じ入力規則を使い、再起動後も全項目を保持する", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-intent-"));
  const path = join(directory, "compass.db");
  try {
    const kit = await open(path);
    const { owner, editor, workspace, tokens } = await prepare(kit);
    const asEditor = requestAs(kit.webApp, editor);

    // Editorが全項目を入力して登録する。任意項目を省略した作成・空欄はnull（未設定）。
    const created = await asEditor(`/api/workspaces/${workspace.id}/intents`, { method: "POST", headers: json, body: JSON.stringify(fullInput) });
    assert.equal(created.status, 201);
    const intent = ((await created.json()) as { intent: Json }).intent;
    assert.deepEqual(pick(intent), fullInput);

    // StrategistはMCPで同じレコードを読み、UIで入れた値を再入力せず一部だけ更新できる。
    const viaMcp = await callTool(kit.remoteApp, tokens.strategist, "get_intent", { workspaceId: workspace.id, intentId: intent.id }, "strategist");
    assert.deepEqual(pick(viaMcp.structuredContent), fullInput);
    const updated = await callTool(kit.remoteApp, tokens.strategist, "update_intent", {
      workspaceId: workspace.id, intentId: intent.id, audience: "有料利用を検討する既存の無料会員。", targetDate: "2027-06-30", constraints: "",
    }, "strategist");
    assert.equal(updated.isError, undefined, JSON.stringify(updated.structuredContent));
    const expected = { ...fullInput, audience: "有料利用を検討する既存の無料会員。", targetDate: "2027-06-30", constraints: null };
    assert.deepEqual(pick(updated.structuredContent), expected);
    const viaWeb = ((await (await asEditor(`/api/workspaces/${workspace.id}/intents/${intent.id}`)).json()) as { intent: Json }).intent;
    assert.deepEqual(viaWeb, updated.structuredContent);

    // 同じ入力規則: 必須（目標名・実現したい状態）・上限・暦日を、Web APIとMCPが同じissue pathで拒否する。
    const invalid = { title: " ", desiredState: "", background: "x".repeat(2_001), targetDate: "2027-02-30" };
    const webInvalid = await asEditor(`/api/workspaces/${workspace.id}/intents/${intent.id}`, { method: "PATCH", headers: json, body: JSON.stringify(invalid) });
    assert.equal(webInvalid.status, 400);
    const webIssues = ((await webInvalid.json()) as { error: { issues: { path: string }[] } }).error.issues.map(({ path }) => path);
    const mcpInvalid = await callTool(kit.remoteApp, tokens.strategist, "update_intent", { workspaceId: workspace.id, intentId: intent.id, ...invalid }, "strategist");
    assert.equal(mcpInvalid.structuredContent.error.code, "VALIDATION_ERROR");
    assert.deepEqual(mcpInvalid.structuredContent.error.issues.map(({ path }: { path: string }) => path), webIssues);
    assert.deepEqual(webIssues, ["title", "desiredState", "background", "targetDate"]);
    for (const targetDate of ["2027/03/31", "2027-3-31", "2027-03-31T00:00:00Z"]) {
      const rejected = await callTool(kit.remoteApp, tokens.strategist, "update_intent", { workspaceId: workspace.id, intentId: intent.id, targetDate }, "strategist");
      assert.equal(rejected.structuredContent.error.code, "VALIDATION_ERROR", targetDate);
    }

    // 登録・更新の記録主体: Editorの操作はHuman、StrategistのMCP操作はAgent（Strategist）で、Humanとして記録しない。
    const activities = ((await (await requestAs(kit.webApp, owner)(`/api/workspaces/${workspace.id}/activities`)).json()) as { activities: Json[] }).activities;
    const intentActivities = activities.filter((activity) => activity.refs.some((ref: Json) => ref.kind === "intent" && ref.id === intent.id));
    assert.deepEqual(intentActivities.map((activity) => [activity.type, activity.principalId, activity.role]), [
      ["intent.created", `human:${editor.humanUserId}`, "operator"],
    ]);
    const second = await callTool(kit.remoteApp, tokens.strategist, "create_intent", { workspaceId: workspace.id, title: "第二の目標", desiredState: "別の状態" }, "strategist");
    assert.equal(second.isError, undefined);
    assert.equal(second.structuredContent.status, "active");
    const both = await callTool(kit.remoteApp, tokens.strategist, "list_intents", { workspaceId: workspace.id }, "strategist");
    assert.deepEqual(both.structuredContent.intents.map((item: Json) => item.id), [second.structuredContent.id, intent.id]);
    await kit.database.destroy();

    // 同じDB fileを開き直した新しいServerでも、全項目が保持される。
    const restarted = await open(path);
    try {
      const afterRestart = ((await (await requestAs(restarted.webApp, editor)(`/api/workspaces/${workspace.id}/intents/${intent.id}`)).json()) as { intent: Json }).intent;
      assert.deepEqual(afterRestart, viaWeb);
      const mcpAfterRestart = await callTool(restarted.remoteApp, tokens.strategist, "list_intents", { workspaceId: workspace.id }, "strategist");
      assert.deepEqual(mcpAfterRestart.structuredContent.intents, [second.structuredContent, viaWeb]);
    } finally {
      await restarted.database.destroy();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Intentの登録・更新はWorkspaceのStrategistだけがMCPで行え、Worker・Reviewer・別WorkspaceのCredentialとViewerは拒否される", async () => {
  const kit = await open(":memory:");
  try {
    const { owner, editor, workspace, other, tokens } = await prepare(kit);
    const create = { workspaceId: workspace.id, title: "Agentが整理した目標", desiredState: "外部クライアントでHumanと整理した状態" };

    // Worker・Reviewer（Project Role）と別WorkspaceのStrategistは、作成・更新ともFORBIDDEN。
    for (const [token, role] of [[tokens.worker, "worker"], [tokens.reviewer, "reviewer"], [tokens.otherStrategist, "strategist"]] as const) {
      const denied = await callTool(kit.remoteApp, token, "create_intent", create, role);
      assert.equal(denied.structuredContent.error.code, "FORBIDDEN", role);
    }
    assert.equal((await kit.services.listIntentsUseCase.execute(workspace.id)).length, 0);

    // WorkspaceのStrategistは作成でき、操作者はStrategist（Agent）として記録される。
    const created = await callTool(kit.remoteApp, tokens.strategist, "create_intent", { ...create, background: "相談で整理した背景" }, "strategist");
    assert.equal(created.isError, undefined, JSON.stringify(created.structuredContent));
    const intentId = created.structuredContent.id as string;
    assert.equal(created.structuredContent.background, "相談で整理した背景");
    assert.equal(created.structuredContent.targetDate, null);

    for (const [token, role] of [[tokens.worker, "worker"], [tokens.reviewer, "reviewer"], [tokens.otherStrategist, "strategist"]] as const) {
      const denied = await callTool(kit.remoteApp, token, "update_intent", { workspaceId: workspace.id, intentId, title: "書換え" }, role);
      assert.equal(denied.structuredContent.error.code, "FORBIDDEN", role);
    }
    // 別WorkspaceのCredentialは、自分のWorkspaceのIDを指定しても他WorkspaceのIntentを更新できない（NOT_FOUND）。
    const crossed = await callTool(kit.remoteApp, tokens.otherStrategist, "update_intent", { workspaceId: other.id, intentId, title: "書換え" }, "strategist");
    assert.equal(crossed.structuredContent.error.code, "NOT_FOUND");
    assert.equal((await kit.services.getIntentUseCase.execute(workspace.id, intentId)).title, create.title);

    // Viewerは閲覧だけで、Web APIの作成・更新は拒否される。EditorはStrategistの登録した目標を再入力せず更新できる。
    const viewer = await createTestHuman(kit.database);
    await addTestWorkspaceMembership(kit.database, workspace.id, viewer, "viewer");
    const viewerPatch = await requestAs(kit.webApp, viewer)(`/api/workspaces/${workspace.id}/intents/${intentId}`, { method: "PATCH", headers: json, body: JSON.stringify({ title: "書換え" }) });
    assert.equal(viewerPatch.status, 403);
    const editorPatch = await requestAs(kit.webApp, editor)(`/api/workspaces/${workspace.id}/intents/${intentId}`, { method: "PATCH", headers: json, body: JSON.stringify({ targetDate: "2027-12-31" }) });
    assert.equal(editorPatch.status, 200);
    const patched = ((await editorPatch.json()) as { intent: Json }).intent;
    assert.deepEqual([patched.title, patched.background, patched.targetDate], [create.title, "相談で整理した背景", "2027-12-31"]);

    const activities = ((await (await requestAs(kit.webApp, owner)(`/api/workspaces/${workspace.id}/activities`)).json()) as { activities: Json[] }).activities;
    const created_ = activities.find((activity) => activity.type === "intent.created");
    assert.deepEqual([created_?.principalId, created_?.role], ["strategist-a", "strategist"]);
    assert.ok(!String(created_?.principalId).startsWith("human:"));

    // Human管理toolはremote modeのMCPへ公開しない（Intentの放棄・Projectの作成・更新）。
    const listed = await kit.remoteApp.request("/mcp", {
      method: "POST",
      headers: { ...json, Accept: "application/json, text/event-stream", Authorization: `Bearer ${tokens.strategist}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/list", params: {} }),
    });
    const names = (JSON.parse((await listed.text()).split("\n").find((line) => line.startsWith("data: "))!.slice(6)).result.tools as { name: string }[]).map(({ name }) => name);
    for (const name of ["abandon_intent", "create_project", "update_project"]) assert.ok(!names.includes(name), name);
    for (const name of ["create_intent", "update_intent"]) assert.ok(names.includes(name), name);
  } finally {
    await kit.database.destroy();
  }
});
