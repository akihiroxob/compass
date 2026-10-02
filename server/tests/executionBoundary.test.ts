import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Direction（packages/direction）とWork（packages/work）が、互いのRepository・tableを直接使わないことの境界test。
 * ソースを静的に走査するため、境界を越える依存を足すとここで失敗する。WorkがDirectionを見るのは公開index（`@compass/direction`）の
 * 相関IDの契約・Evidence還流のport型・archive時のerrorだけで、DirectionからWorkへの依存は持たない。
 * Project状態・Role Grantは、serverがWorkの`WorkStore`へ同じtransactionで読む実装を渡す（Workはproject・project_grantを読まない）。
 */

const repositoryRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));

const listSources = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return name === "web" || name === "node_modules" ? [] : listSources(path);
    return path.endsWith(".ts") ? [path] : [];
  });

const sourcesOf = (directory: string) =>
  listSources(join(repositoryRoot, directory)).map((path) => ({
    path,
    name: relative(repositoryRoot, path),
    text: readFileSync(path, "utf-8"),
  }));

const workFiles = sourcesOf("packages/work/src");
const directionFiles = sourcesOf("packages/direction/src");
const sharedFiles = sourcesOf("packages/shared/src");
const serverFiles = sourcesOf("server/src");

const workTables = ["story", "task", "task_claim", "task_comment", "change_log", "command_receipt"];

const tablesQueriedIn = (text: string) =>
  [...text.matchAll(/\.(?:selectFrom|insertInto|updateTable|deleteFrom|innerJoin|leftJoin)\(\s*"([a-z_]+)(?:\s+as\s+[a-z_]+)?"/g)].map(
    (match) => match[1]!,
  );

const importsOf = (text: string) => [...text.matchAll(/from\s+"([^"]+)"/g)].map((match) => match[1]!);

/** `import { a, type B } from "<specifier>"`で取り込む名前。 */
const importedNames = (text: string, specifier: string) =>
  [...text.matchAll(new RegExp(`import (?:type )?\\{([^}]*)\\} from "${specifier}"`, "g"))].flatMap((match) =>
    match[1]!
      .split(",")
      .map((name) => name.trim().replace(/^type /, ""))
      .filter(Boolean),
  );

test("走査対象のpackageが空振りしていない", () => {
  assert.ok(workFiles.length >= 8, "Workのソースを走査できている");
  assert.ok(directionFiles.length > 40, "Directionのソースを走査できている");
  assert.ok(sharedFiles.length >= 2, "sharedのソースを走査できている");
});

test("Workが読み書きするtableはWork自身のtableだけで、project・project_grantも直接読まない", () => {
  const queried = new Set(workFiles.flatMap((file) => tablesQueriedIn(file.text)));
  assert.ok(queried.has("task_claim") && queried.has("story") && queried.has("change_log"), "走査が空振りしていない");
  assert.deepEqual([...queried].filter((table) => !workTables.includes(table)), []);
});

test("Workのapplication・domainはDB clientとinfrastructureに依存しない（SQLはWorkStoreの実装だけ）", () => {
  for (const file of workFiles.filter((file) => !file.name.includes("/infrastructure/") && !file.name.endsWith("/index.ts"))) {
    assert.deepEqual(tablesQueriedIn(file.text), [], `${file.name} がSQLを組み立てている`);
    for (const specifier of importsOf(file.text)) {
      assert.notEqual(specifier, "kysely", `${file.name} がKyselyをimportしている`);
      assert.doesNotMatch(specifier, /infrastructure\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("WorkはDirectionの公開indexの契約だけを使い、DirectionのRepository・use case・tableを使わない", () => {
  const allowed = new Set([
    "outcomeCorrelationId",
    "ProjectArchivedError",
    "ExecutionSummaryPort",
    "ExecutionSummarySnapshot",
    "ExecutionSummaryState",
    "ExecutionStorySummary",
    "ExecutionSummaryTaskCounts",
  ]);
  for (const file of workFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.ok(!specifier.startsWith("@compass/direction/"), `${file.name} がDirectionの内部 ${specifier} をimportしている`);
    }
    for (const name of importedNames(file.text, "@compass/direction")) {
      assert.ok(allowed.has(name), `${file.name} がDirectionの ${name} を使っている`);
    }
  }
  const port = workFiles.find((file) => file.name === "packages/work/src/application/port/DirectionReferenceLookupPort.ts")!;
  assert.doesNotMatch(port.text, /\b(create|update|cancel|archive|delete|save|insert|record)\w*\s*\(/i, "ポートは書込メソッドを持たない");
  assert.equal(importsOf(port.text).length, 0, "ポートは何にも依存しない");
});

test("DirectionはWorkのtable・packageを使わない", () => {
  for (const file of directionFiles) {
    const touched = tablesQueriedIn(file.text).filter((table) => workTables.includes(table));
    assert.deepEqual(touched, [], `${file.name} がWorkのtableを直接使っている`);
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/work/, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("packageはserverとAccessのtableに依存せず、sharedは業務packageに依存しない", () => {
  const accessTables = ["project_grant", "project_membership", "project_invitation", "human_user", "access_credential"];
  for (const file of [...workFiles, ...directionFiles, ...sharedFiles]) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/server|(?:\.\.\/)+server\//, `${file.name} が ${specifier} をimportしている`);
    }
    const touched = tablesQueriedIn(file.text).filter((table) => accessTables.includes(table));
    assert.deepEqual(touched, [], `${file.name} がAccessのtableを直接使っている`);
  }
  for (const file of sharedFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Direction・Workのdomainはframework・DB client・application層に依存しない", () => {
  const domainFiles = [...workFiles, ...directionFiles].filter((file) => file.name.includes("/src/domain/"));
  assert.ok(domainFiles.length > 10, "domainのソースを走査できている");
  for (const file of domainFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.match(specifier, /^\.\/[A-Za-z]+\.ts$/, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Work・Directionの連携に、別Wacha server・localhost HTTP・内部loopbackを使わない", () => {
  for (const file of [...serverFiles, ...workFiles, ...directionFiles]) {
    assert.doesNotMatch(file.text, /\bfetch\(\s*["'`]https?:\/\/(?:localhost|127\.0\.0\.1)/, `${file.name} がloopback HTTPを呼んでいる`);
    assert.doesNotMatch(file.text, /StreamableHTTPClientTransport|createMcpClient|new Client\(/, `${file.name} が内部MCPクライアントを使っている`);
  }
  const server = readFileSync(join(repositoryRoot, "server/src/main.ts"), "utf-8");
  // 起動するserverは一つ（同一Hono・同一port）。
  assert.equal([...server.matchAll(/\bserve\(/g)].length, 1);
});
