import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * DirectionとExecutionが、互いのRepository・SQLite tableを直接使わないことの境界test（Task 33）。
 * ソースを静的に走査するため、境界を越える依存を足すとここで失敗する。
 * 例外は設計文書（docs/lv6-unification-design.md）に記録した共有の根（project・project_grant）と、
 * Story作成時にだけ通す読取専用ポート（DirectionReferenceLookupPort）に限る。
 */

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const sourceRoot = join(root, "src");

const listSources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "frontend" ? [] : listSources(path);
    return path.endsWith(".ts") ? [path] : [];
  });

const files = listSources(sourceRoot).map((path) => ({ path, name: relative(root, path), text: readFileSync(path, "utf-8") }));

const isExecution = (name: string) =>
  name.startsWith("src/application/service/execution/") ||
  name.startsWith("src/domain/model/execution/") ||
  name === "src/presentation/mcp/registerExecutionTools.ts";

const executionFiles = files.filter((file) => isExecution(file.name));

const executionTables = ["story", "task", "task_claim", "task_comment", "change_log", "command_receipt"];
/** Executionが読んでよいDirection側のtable。共有の根（Project・Role Grant）だけ。 */
const sharedRootTables = ["project", "project_grant"];

const tablesQueriedIn = (text: string) =>
  [...text.matchAll(/\.(?:selectFrom|insertInto|updateTable|deleteFrom)\(\s*"([a-z_]+)(?:\s+as\s+[a-z_]+)?"/g)].map((match) => match[1]!);

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);

test("Executionのコードが読み書きするtableは、Execution自身のtableと共有の根（project・project_grant）だけ", () => {
  assert.ok(executionFiles.length >= 4, "Executionのソースを走査できている");
  const queried = new Set(executionFiles.flatMap((file) => tablesQueriedIn(file.text)));
  assert.ok(queried.has("task_claim") && queried.has("story") && queried.has("change_log"), "走査が空振りしていない");
  const allowed = new Set([...executionTables, ...sharedRootTables]);
  assert.deepEqual([...queried].filter((table) => !allowed.has(table)), []);
  // 共有の根は読むだけ。Direction側のProject・Grantを書き換えない。
  for (const file of executionFiles) {
    for (const table of sharedRootTables) {
      assert.doesNotMatch(file.text, new RegExp(`\\.(?:insertInto|updateTable|deleteFrom)\\(\\s*"${table}"`), `${file.name} が ${table} を書き換えている`);
    }
  }
});

test("ExecutionはDirectionのRepository・use case・model・infrastructureをimportせず、Directionを見るのは読取専用ポートだけ", () => {
  const forbidden = [/\/domain\/repository\//, /\/application\/usecase\//, /\/infrastructure\/repository\//, /\/domain\/model\/(?!execution\/)/];
  for (const file of executionFiles) {
    for (const specifier of importsOf(file.text)) {
      for (const pattern of forbidden) assert.doesNotMatch(specifier, pattern, `${file.name} が ${specifier} をimportしている`);
    }
  }
  const port = files.find((file) => file.name === "src/application/port/DirectionReferenceLookupPort.ts")!;
  assert.doesNotMatch(port.text, /\b(create|update|cancel|archive|delete|save|insert|record)\w*\s*\(/i, "ポートは書込メソッドを持たない");
  assert.equal(importsOf(port.text).length, 0, "ポートは何にも依存しない");
});

test("Directionのコードは、Executionのtable・model・serviceを直接使わない", () => {
  const allowedToTouchExecution = new Set([
    // DB定義・型
    "src/infrastructure/database/schema.ts",
    "src/infrastructure/database/initializeSchema.ts",
    // Directionのapplication境界へExecutionを配線する唯一の場所と、MCP公開層
    "src/createApplicationServices.ts",
    "src/presentation/mcp/createMcpServer.ts",
    "src/presentation/mcp/toolExecution.ts",
  ]);
  const directionFiles = files.filter((file) => !isExecution(file.name) && !allowedToTouchExecution.has(file.name));
  assert.ok(directionFiles.length > 40, "Directionのソースを走査できている");
  for (const file of directionFiles) {
    const touched = tablesQueriedIn(file.text).filter((table) => executionTables.includes(table));
    assert.deepEqual(touched, [], `${file.name} がExecutionのtableを直接使っている`);
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /\/execution\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Execution・Directionの連携に、別Wacha server・localhost HTTP・内部loopbackを使わない", () => {
  for (const file of files) {
    if (file.name.startsWith("src/frontend/")) continue;
    assert.doesNotMatch(file.text, /\bfetch\(\s*["'`]https?:\/\/(?:localhost|127\.0\.0\.1)/, `${file.name} がloopback HTTPを呼んでいる`);
    assert.doesNotMatch(file.text, /StreamableHTTPClientTransport|createMcpClient|new Client\(/, `${file.name} が内部MCPクライアントを使っている`);
  }
  const server = readFileSync(join(sourceRoot, "server.ts"), "utf-8");
  // 起動するserverは一つ（同一Hono・同一port）。
  assert.equal([...server.matchAll(/\bserve\(/g)].length, 1);
});
