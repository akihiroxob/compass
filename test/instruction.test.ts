import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { createApp } from "../src/app.ts";
import { createSignedInApp } from "./support/humanSession.ts";
import { InstructionUnavailableError } from "../src/application/error/InstructionUnavailableError.ts";
import { InstructionService } from "../src/application/service/InstructionService.ts";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const setup = async (instructionService?: InstructionService) => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  return { database, app: await createSignedInApp(database, createApplicationServices(database, instructionService)) };
};

const rpc = async (app: ReturnType<typeof createApp>, method: string, params: object, authorization?: string) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6));
};

const getInstructions = async (app: ReturnType<typeof createApp>, args: object, authorization?: string) =>
  (await rpc(app, "tools/call", { name: "get_role_instructions", arguments: args }, authorization))
    .result as ToolResult;

/** 一時的なagentディレクトリ。欠落時の挙動を、実際のagent/を壊さずに確認する。 */
const withAgentDir = async (files: Record<string, string>, run: (root: string) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "compass-agent-"));
  try {
    await mkdir(root, { recursive: true });
    for (const [name, content] of Object.entries(files)) await writeFile(join(root, name), content);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("InstructionServiceはrole-policyとRole名からagent/<name>.mdを読む", async () => {
  const service = new InstructionService();
  const policy = await service.getInstructionContent("role-policy");
  assert.equal(policy, await readFile(new URL("../agent/role-policy.md", import.meta.url), "utf-8"));
  assert.ok(policy.includes("# Role Policy"));
  const strategist = await service.getInstructionContent("strategist");
  assert.equal(strategist, await readFile(new URL("../agent/strategist.md", import.meta.url), "utf-8"));
  assert.ok(strategist.includes("# Strategist Role"));
});

test("InstructionServiceはincludeSharedのときだけsharedを先頭に含める", async () => {
  const service = new InstructionService();
  const withShared = await service.getRoleInstructions("strategist", true);
  assert.deepEqual(
    withShared.files.map((file) => [file.path, file.kind]),
    [
      ["agent/role-policy.md", "shared"],
      ["agent/strategist.md", "role"],
    ],
  );
  for (const omitted of [undefined, false]) {
    const roleOnly = await service.getRoleInstructions("strategist", omitted);
    assert.equal(roleOnly.includeShared, false);
    assert.deepEqual(
      roleOnly.files.map((file) => [file.path, file.kind]),
      [["agent/strategist.md", "role"]],
    );
  }
});

test("Instructionファイルが無い・読めない場合はpath入りのINSTRUCTION_UNAVAILABLEで失敗し、部分的な応答を返さない", async () => {
  await withAgentDir({ "role-policy.md": "# Role Policy" }, async (root) => {
    const service = new InstructionService(root);
    await assert.rejects(
      () => service.getInstructionContent("strategist"),
      (error) =>
        error instanceof InstructionUnavailableError &&
        error.code === "INSTRUCTION_UNAVAILABLE" &&
        error.path === "agent/strategist.md" &&
        error.message.includes("agent/strategist.md"),
    );
    await assert.rejects(() => service.getRoleInstructions("strategist", true), InstructionUnavailableError);
  });
  await withAgentDir({ "strategist.md": "# Strategist Role" }, async (root) => {
    await assert.rejects(
      () => new InstructionService(root).getRoleInstructions("strategist", true),
      (error) => error instanceof InstructionUnavailableError && error.path === "agent/role-policy.md",
    );
  });
});

test("列挙外のInstruction名はagent外のfileを読まずに拒否する", async () => {
  const service = new InstructionService();
  for (const name of ["../package", "admin", "strategist/../role-policy", ""]) {
    await assert.rejects(() => service.getInstructionContent(name as never), InstructionUnavailableError, name);
  }
});

test("get_role_instructionsはBearerなしでもWacha互換の形で返す", async () => {
  const { database, app } = await setup();
  const result = await getInstructions(app, { role: "strategist", includeShared: true });
  assert.equal(result.isError, undefined);
  const value = result.structuredContent;
  assert.deepEqual(Object.keys(value).sort(), ["files", "includeShared", "role"]);
  assert.equal(value.role, "strategist");
  assert.equal(value.includeShared, true);
  assert.equal(value.files.length, 2);
  for (const file of value.files) assert.deepEqual(Object.keys(file).sort(), ["content", "kind", "path"]);
  assert.deepEqual(
    value.files.map((file: { path: string; kind: string }) => [file.path, file.kind]),
    [
      ["agent/role-policy.md", "shared"],
      ["agent/strategist.md", "role"],
    ],
  );
  assert.equal(value.files[0].content, await readFile(new URL("../agent/role-policy.md", import.meta.url), "utf-8"));
  assert.equal(value.files[1].content, await readFile(new URL("../agent/strategist.md", import.meta.url), "utf-8"));

  // Bearer付き・Grantなしでも同じ応答。
  const withBearer = await getInstructions(app, { role: "strategist", includeShared: true }, "Bearer nobody");
  assert.deepEqual(withBearer.structuredContent, value);

  // includeShared省略・falseではRole文書のみ。
  for (const args of [{ role: "strategist" }, { role: "strategist", includeShared: false }]) {
    const roleOnly = (await getInstructions(app, args)).structuredContent;
    assert.equal(roleOnly.includeShared, false);
    assert.deepEqual(
      roleOnly.files.map((file: { path: string; kind: string }) => [file.path, file.kind]),
      [["agent/strategist.md", "role"]],
    );
  }
  await database.destroy();
});

test("get_role_instructionsはenum外のroleを入力検証で拒否する", async () => {
  const { database, app } = await setup();
  for (const role of ["admin", "Manager", "Strategist", ""]) {
    const result = await getInstructions(app, { role, includeShared: true });
    assert.equal(result.isError, true, role);
  }
  await database.destroy();
});

test("get_role_instructionsはファイル欠落をpath入りのINSTRUCTION_UNAVAILABLE（isError）で返す", async () => {
  await withAgentDir({ "role-policy.md": "# Role Policy" }, async (root) => {
    const { database, app } = await setup(new InstructionService(root));
    const result = await getInstructions(app, { role: "strategist", includeShared: true });
    assert.equal(result.isError, true);
    assert.equal(result.structuredContent.error.code, "INSTRUCTION_UNAVAILABLE");
    assert.ok(result.structuredContent.error.message.includes("agent/strategist.md"));
    assert.equal(result.structuredContent.files, undefined);
    await database.destroy();
  });
});

test("strategist.mdは必須の節を持ち、記載したtool名がすべてtools/listに存在する", async () => {
  const { database, app } = await setup();
  const content = (await getInstructions(app, { role: "strategist" })).structuredContent.files[0].content as string;
  for (const section of [
    "Goal",
    "対象 Project の決定",
    "Input",
    "判断権限",
    "実行手順",
    "作成結果が不明な場合",
    "Output",
    "Allowed",
    "Forbidden",
    "Success Criterion の固定",
  ]) {
    assert.match(content, new RegExp(`^## ${section}$`, "m"), section);
  }
  for (const phrase of ["Research", "自己評価", "Human の確認・承認・すり合わせを求めない", "Evidence の捏造"]) {
    assert.ok(content.includes(phrase), phrase);
  }
  for (const phrase of [
    "候補が 1 件なら自動的に対象とする",
    "一覧順・名前・更新日時・内容から勝手に 1 件を選ばない",
    "再取得できない間は `create_outcome` を再送しない",
    "同じ入力の `create_outcome` を 1 回だけ再送する",
    "`requestId` による冪等性をまだ提供しない",
  ]) {
    assert.ok(content.includes(phrase), phrase);
  }

  const listed = await rpc(app, "tools/list", {});
  const toolNames = new Set((listed.result.tools as { name: string }[]).map((tool) => tool.name));
  const mentioned = [...content.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map((match) => match[1]);
  assert.ok(mentioned.includes("create_outcome"));
  for (const name of mentioned) assert.ok(toolNames.has(name), `${name} は tools/list に無い`);
  // 明示的に使う手順のtoolは、Instruction上でも許可されている。
  for (const name of ["get_role_instructions", "get_strategist_context", "create_outcome", "cancel_outcome"]) {
    assert.ok(mentioned.includes(name), name);
  }
  await database.destroy();
});

test("Instructionは人による確認・承認を工程や取得条件にせず、通常フローに置かないと明記する", async () => {
  const { files } = await new InstructionService().getRoleInstructions("strategist", true);
  // 「待たない」「置かない」の否定文は許すため、工程化する肯定形の言い回しだけを検査する。
  const gatePhrasesToAvoid = ["承認を待つ", "承認を得てから", "承認後に", "確認を求めて待つ", "人に確認してから", "画面で確認してから"];
  for (const file of files) {
    for (const phrase of gatePhrasesToAvoid) assert.ok(!file.content.includes(phrase), `${file.path}: ${phrase}`);
  }
  assert.ok(files[0].content.includes("通常フローに Human の確認・承認・画面操作を置かない"));
  assert.ok(files[1].content.includes("Human の確認・承認・すり合わせを求めない"));
});
