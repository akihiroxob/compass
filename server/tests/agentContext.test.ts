import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { projectRoles } from "@compass/access";
import type { createApp } from "../src/bootstrap/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { AgentContextService } from "../src/application/agentContext/AgentContextService.ts";
import { InstructionUnavailableError } from "../src/application/agentContext/InstructionUnavailableError.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { FileAgentAssetRepository } from "../src/infrastructure/agentAssets/FileAgentAssetRepository.ts";
import { parseFrontmatter } from "../src/infrastructure/agentAssets/frontmatter.ts";

/**
 * Role・Policy・Skill・KnowledgeのJIT配信（docs/architecture-migration-mapping.md Task 06）。
 * Role→Skillの一方向参照、Skillに認可を持たせないこと、namespace付きTool metadata、Git revisionでの再現性を確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const git = promisify(execFile);
const repoRoot = new URL("../../", import.meta.url);

const setup = async (agentContextService?: AgentContextService) => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, app: await createSignedInApp(database, createApplicationServices(database, agentContextService)) };
};

let rpcId = 0;
const rpc = async (app: App, method: string, params: object, principal?: string, activeRole?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(principal === undefined ? {} : { Authorization: `Bearer ${principal}` }),
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const callTool = async (app: App, name: string, args: object, principal?: string, activeRole?: string) =>
  (await rpc(app, "tools/call", { name, arguments: args }, principal, activeRole)).result as ToolResult;

const send = (app: App, method: string, path: string, body?: unknown) =>
  app.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const createProject = async (app: App) =>
  (
    (await (
      await send(app, "POST", "/api/projects", {
        name: "Compass",
        mission: "Keep execution guarded",
        principles: ["Small steps"],
        repositories: [{ name: "primary", url: "https://example.com/compass.git" }],
        resources: [{ name: "design", url: "https://example.com/docs", kind: "docs" }],
      })
    ).json()) as { project: { id: string } }
  ).project.id;

const grant = (app: App, projectId: string, principalId: string, role: string) =>
  send(app, "POST", `/api/projects/${projectId}/grants`, { principalId, role });

/** 一時的な構成資産のroot。gitを使うtestでは同じrootでrepositoryを作る。 */
const withAssetRoot = async (files: Record<string, string>, run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "compass-assets-"));
  try {
    await writeAssets(root, files);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const writeAssets = async (root: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), content);
  }
};

const skillFile = (name: string, extra = "requiredKnowledge:\n  - tips/a.md\nrequiredTools:\n  - compass:list_tasks\n") =>
  `---\nname: ${name}\ndescription: ${name} の手順\nstatus: active\nversion: 2\n${extra}---\n\n# ${name}\n\n手順本文\n`;

const minimalAssets = {
  "roles/worker.md": "---\nskills:\n  - implement\n---\n\n# Worker Role\n",
  "roles/reviewer.md": "# Reviewer Role\n",
  "policies/role-policy.md": "# Role Policy\n",
  "skills/implement.md": skillFile("implement"),
  "knowledge/tips/a.md": "# Tip A\n",
};

const gitAvailable = await git("git", ["--version"]).then(
  () => true,
  () => false,
);

test("frontmatterはscalar・数値・inline list・block listを読み、本文から除く。解釈できない行は例外", () => {
  const parsed = parseFrontmatter("---\nname: a\nversion: 3\ntags: [x, 'y']\nlist:\n  - p\n  - \"q\"\n---\n\n# Body\n");
  assert.deepEqual(parsed.data, { name: "a", version: 3, tags: ["x", "y"], list: ["p", "q"] });
  assert.equal(parsed.content, "# Body");
  assert.deepEqual(parseFrontmatter("# No frontmatter\n"), { data: {}, content: "# No frontmatter" });
  assert.throws(() => parseFrontmatter("---\nname: a\n  nested: b\n---\n"));
});

test("repoの資産: RoleだけがSkillを参照し、SkillはallowRolesを持たず、requiredKnowledgeとnamespace付きTool metadataが解決できる", async () => {
  const repository = new FileAgentAssetRepository();
  const skills = await repository.listSkills();
  const skillNames = new Set(skills.map((skill) => skill.name));
  const referenced = new Set<string>();
  for (const role of projectRoles) {
    for (const name of (await repository.getRole(role)).skills) {
      assert.ok(skillNames.has(name), `roles/${role}.md: ${name}`);
      referenced.add(name);
    }
  }
  assert.deepEqual([...referenced].sort(), [...skillNames].sort(), "どのRoleからも参照されないSkillは無い");
  assert.deepEqual((await repository.getRole("worker")).skills, ["implement-task", "propose-knowledge-update"]);
  assert.deepEqual((await repository.getRole("reviewer")).skills, ["review-task", "propose-knowledge-update"]);
  assert.ok((await repository.getRole("manager")).skills.includes("accept-task"));

  const { app, database } = await setup();
  const listed = await rpc(app, "tools/list", {});
  const toolNames = new Set((listed.result.tools as { name: string }[]).map((tool) => tool.name));
  for (const file of await readdir(new URL("skills/", repoRoot))) {
    const raw = await readFile(new URL(`skills/${file}`, repoRoot), "utf-8");
    // SkillはRoleを知らない（frontmatterにallowRoles等のRole指定を持たない）。
    assert.equal(/^allowRoles:/m.test(raw), false, file);
  }
  for (const skill of skills) {
    for (const path of skill.requiredKnowledge) await repository.getKnowledge(path);
    assert.ok(skill.requiredTools.length > 0, skill.name);
    for (const tool of skill.requiredTools) {
      assert.match(tool, /^[a-z][a-z0-9-]*:[a-z_]+$/, `${skill.name}: ${tool}`);
      if (tool.startsWith("compass:")) assert.ok(toolNames.has(tool.slice("compass:".length)), `${skill.name}: ${tool}`);
    }
  }
  await database.destroy();
});

test("get_role_contextはRole・Policy・Skill metadata・Project情報・Resourcesを返し、Skill本文・Knowledge本文を含めない", async () => {
  const { app, database } = await setup();
  const projectId = await createProject(app);
  await grant(app, projectId, "worker-a", "worker");

  const result = await callTool(app, "get_role_context", { projectId, role: "worker" }, "worker-a");
  assert.equal(result.isError, undefined);
  const context = result.structuredContent;
  assert.deepEqual(Object.keys(context).sort(), ["policies", "project", "resources", "role", "skills", "source", "unavailable"]);
  const roleFile = await readFile(new URL("roles/worker.md", repoRoot), "utf-8");
  assert.equal(context.role.name, "worker");
  assert.equal(context.role.path, "roles/worker.md");
  assert.deepEqual(context.role.skills, ["implement-task", "propose-knowledge-update"]);
  assert.ok(context.role.content.startsWith("# Worker Role"));
  assert.ok(roleFile.endsWith(`${context.role.content}\n`));
  assert.deepEqual(
    context.policies.map((policy: { path: string }) => policy.path),
    ["policies/role-policy.md"],
  );
  assert.equal(context.policies[0].content, await readFile(new URL("policies/role-policy.md", repoRoot), "utf-8"));
  assert.deepEqual(
    context.skills.map((skill: { name: string }) => skill.name),
    ["implement-task", "propose-knowledge-update"],
  );
  for (const skill of context.skills) {
    assert.deepEqual(Object.keys(skill).sort(), ["description", "name", "path", "requiredKnowledge", "requiredTools", "status", "version"]);
  }
  assert.equal(JSON.stringify(context).includes("# implement-task"), false, "Skill本文は含めない");
  assert.equal(context.project.id, projectId);
  assert.equal(context.project.mission, "Keep execution guarded");
  assert.deepEqual(context.project.principles, ["Small steps"]);
  assert.equal(context.project.status, "active");
  assert.deepEqual(context.resources.repositories.map((item: { url: string }) => item.url), ["https://example.com/compass.git"]);
  assert.deepEqual(context.resources.resources.map((item: { kind: string }) => item.kind), ["docs"]);
  // Activity summaryは未接続（Task 07）であることを明示し、空の履歴として偽装しない。
  assert.deepEqual(context.unavailable, ["activity"]);
  if (gitAvailable) {
    const head = (await git("git", ["rev-parse", "HEAD"], { cwd: new URL(".", repoRoot) })).stdout.trim();
    assert.equal(context.source.revision, head);
    assert.equal(typeof context.source.dirty, "boolean");
  }
  await database.destroy();
});

test("get_role_contextは要求RoleのGrantを要求し、activeRoleと異なるRoleのContextは返さない", async () => {
  const { app, database } = await setup();
  const projectId = await createProject(app);
  const otherProjectId = await createProject(app);
  await grant(app, projectId, "worker-a", "worker");
  await grant(app, projectId, "both", "worker");
  await grant(app, projectId, "both", "reviewer");

  const errorCode = (result: ToolResult) => (result.isError ? result.structuredContent.error.code : null);
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId, role: "worker" })), "UNAUTHENTICATED");
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId, role: "reviewer" }, "worker-a")), "FORBIDDEN");
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId: otherProjectId, role: "worker" }, "worker-a")), "FORBIDDEN");
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId: "missing", role: "worker" }, "worker-a")), "FORBIDDEN");
  // 複数Grantを持っていても、activeRoleと異なるRoleのContextは取得できない。
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId, role: "reviewer" }, "both", "worker")), "FORBIDDEN");
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId, role: "worker" }, "both", "worker")), null);
  assert.equal(errorCode(await callTool(app, "get_role_context", { projectId, role: "reviewer" }, "both", "reviewer")), null);
  assert.equal((await callTool(app, "get_role_context", { projectId, role: "admin" }, "worker-a")).isError, true);
  await database.destroy();
});

test("list_skillsはmetadataだけを返し、roleはRole Definitionの参照で絞る。get_skill_contextは本文とrequiredKnowledgeを返す", async () => {
  const { app, database } = await setup();
  const all = (await callTool(app, "list_skills", {})).structuredContent;
  const names = all.skills.map((skill: { name: string }) => skill.name);
  assert.deepEqual(names, [...names].sort());
  assert.ok(names.includes("implement-task") && names.includes("accept-task"));
  for (const skill of all.skills) assert.equal("content" in skill, false);

  const forReviewer = (await callTool(app, "list_skills", { role: "reviewer" })).structuredContent;
  assert.deepEqual(forReviewer.skills.map((skill: { name: string }) => skill.name), ["propose-knowledge-update", "review-task"]);
  assert.deepEqual((await callTool(app, "list_skills", { role: "strategist" })).structuredContent.skills, []);
  assert.deepEqual((await callTool(app, "list_skills", { status: "deprecated" })).structuredContent.skills, []);

  const context = (await callTool(app, "get_skill_context", { name: "review-task" })).structuredContent;
  assert.equal(context.skill.name, "review-task");
  assert.equal(context.skill.path, "skills/review-task.md");
  assert.ok(context.skill.content.startsWith("# review-task"));
  assert.ok(context.skill.requiredTools.includes("compass:reviewed_task"));
  assert.deepEqual(
    context.knowledge.map((item: { name: string }) => item.name),
    context.skill.requiredKnowledge,
  );
  for (const item of context.knowledge) {
    assert.equal(item.path, `knowledge/${item.name}`);
    assert.equal(item.content, await readFile(new URL(item.path, repoRoot), "utf-8"));
  }

  const missing = await callTool(app, "get_skill_context", { name: "missing-skill" });
  assert.equal(missing.isError, true);
  assert.equal(missing.structuredContent.error.code, "NOT_FOUND");
  await database.destroy();
});

test("Skillの不正（allowRoles・namespaceなしのTool・未知のSkill参照・Knowledge欠落・knowledge外のpath）はINSTRUCTION_UNAVAILABLEで、部分的な応答を返さない", async () => {
  const unavailable = (path: string) => (error: unknown) =>
    error instanceof InstructionUnavailableError && error.code === "INSTRUCTION_UNAVAILABLE" && error.path === path;

  await withAssetRoot(
    { ...minimalAssets, "skills/implement.md": skillFile("implement", "allowRoles: [worker]\nrequiredTools:\n  - compass:list_tasks\n") },
    async (root) => {
      await assert.rejects(() => new AgentContextService(new FileAgentAssetRepository(root)).listSkills(), unavailable("skills/implement.md"));
    },
  );
  await withAssetRoot(
    { ...minimalAssets, "skills/implement.md": skillFile("implement", "requiredTools:\n  - list_tasks\n") },
    async (root) => {
      await assert.rejects(() => new FileAgentAssetRepository(root).listSkills(), unavailable("skills/implement.md"));
    },
  );
  await withAssetRoot({ ...minimalAssets, "roles/worker.md": "---\nskills: [unknown]\n---\n# Worker\n" }, async (root) => {
    await assert.rejects(() => new AgentContextService(new FileAgentAssetRepository(root)).getRoleAssets("worker"), unavailable("roles/worker.md"));
  });
  const { "knowledge/tips/a.md": _removed, ...withoutKnowledge } = minimalAssets;
  await withAssetRoot(withoutKnowledge, async (root) => {
    const { app, database } = await setup(new AgentContextService(new FileAgentAssetRepository(root)));
    const result = await callTool(app, "get_skill_context", { name: "implement" });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "INSTRUCTION_UNAVAILABLE");
    assert.ok(result.structuredContent.error.message.includes("knowledge/tips/a.md"));
    assert.equal(result.structuredContent.skill, undefined);
    await database.destroy();
  });
  await withAssetRoot(minimalAssets, async (root) => {
    const repository = new FileAgentAssetRepository(root);
    for (const name of ["../roles/worker.md", "/etc/hosts", "tips/../../roles/worker.md", "tips/a.txt"]) {
      await assert.rejects(() => repository.getKnowledge(name), InstructionUnavailableError, name);
    }
    await assert.rejects(() => repository.getPolicy("../roles/worker"), InstructionUnavailableError);
  });
});

test("sourceはGit revisionと未commit変更を示し、revisionの資産から同じSkillを再現できる。Git管理外はnull", { skip: !gitAvailable }, async () => {
  await withAssetRoot(minimalAssets, async (root) => {
    const service = new AgentContextService(new FileAgentAssetRepository(root));
    assert.deepEqual((await service.listSkills()).source, { revision: null, dirty: null });

    const run = (...args: string[]) => git("git", args, { cwd: root });
    await run("init", "-q");
    await run("add", ".");
    await run("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "v1");
    const first = (await run("rev-parse", "HEAD")).stdout.trim();
    const served = await service.getSkillContext("implement");
    assert.deepEqual(served.source, { revision: first, dirty: false });

    // 資産の未commit変更はdirtyで示す（revisionだけでは再現できない）。
    await writeAssets(root, { "skills/implement.md": skillFile("implement").replace("手順本文", "変更後の手順") });
    assert.deepEqual((await service.getSkillContext("implement")).source, { revision: first, dirty: true });
    await run("-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-am", "v2");
    const second = await service.getSkillContext("implement");
    assert.notEqual(second.source.revision, first);
    assert.equal(second.source.dirty, false);
    assert.ok(second.skill.content.includes("変更後の手順"));

    // 記録したrevisionから、当時配信したSkill本文を再現できる。
    const atFirst = (await run("show", `${first}:skills/implement.md`)).stdout;
    assert.equal(parseFrontmatter(atFirst).content, served.skill.content);
  });
});
