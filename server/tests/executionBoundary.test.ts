import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * Organization（packages/organization）・Direction（packages/direction）・Work（packages/work）・Access（packages/access）が、
 * 互いのRepository・tableを直接使わないことの境界test。ソースを静的に走査するため、境界を越える依存を足すとここで失敗する。
 * WorkがDirectionを見るのは公開index（`@compass/direction`）の相関IDの契約・Evidence還流のport型だけで、DirectionからWorkへの依存は持たない。
 * Project（Organization）の状態・Role Grantは、serverがWorkの`WorkStore`へ同じtransactionで読む実装を渡す（Workはproject・project_grantを読まない）。
 * Access・DirectionもProject状態をserverが渡すreaderで読み、projectのtableを直接扱わない。Organizationの公開indexから使うのは
 * archive時のerrorとProjectの参照モデル・use caseの型だけ。
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
const accessFiles = sourcesOf("packages/access/src");
const activityFiles = sourcesOf("packages/activity/src");
const organizationFiles = sourcesOf("packages/organization/src");
const serverFiles = sourcesOf("server/src");

const workTables = ["story", "task", "task_claim", "task_comment", "change_log", "command_receipt"];
const accessTables = [
  "project_grant",
  "human_user",
  "human_identity",
  "web_session",
  "auth_login_attempt",
  "project_membership",
  "project_invitation",
  "access_credential",
  "workspace_membership",
];

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
  assert.ok(accessFiles.length > 25, "Accessのソースを走査できている");
  assert.ok(activityFiles.length >= 8, "Activityのソースを走査できている");
  assert.ok(organizationFiles.length >= 10, "Organizationのソースを走査できている");
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
  for (const file of [...workFiles, ...directionFiles, ...sharedFiles, ...accessFiles]) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/server|(?:\.\.\/)+server\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of [...workFiles, ...directionFiles, ...sharedFiles]) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/access/, `${file.name} が ${specifier} をimportしている`);
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

test("Accessが読み書きするtableはAccess自身のtableだけで、projectも直接読まない", () => {
  const queried = new Set(accessFiles.flatMap((file) => tablesQueriedIn(file.text)));
  assert.ok(queried.has("project_grant") && queried.has("project_membership") && queried.has("web_session"), "走査が空振りしていない");
  assert.deepEqual([...queried].filter((table) => !accessTables.includes(table)), []);
});

test("Accessのapplication・domainはDB clientとinfrastructureに依存しない（SQLはinfrastructureだけ）", () => {
  for (const file of accessFiles.filter((file) => !file.name.includes("/infrastructure/") && !file.name.endsWith("/src/index.ts"))) {
    assert.deepEqual(tablesQueriedIn(file.text), [], `${file.name} がSQLを組み立てている`);
    for (const specifier of importsOf(file.text)) {
      assert.notEqual(specifier, "kysely", `${file.name} がKyselyをimportしている`);
      assert.doesNotMatch(specifier, /infrastructure\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("AccessはDirection・Workに依存しない", () => {
  for (const file of accessFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/(?:direction|work)/, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Direction・Work・AccessはOrganizationの公開indexのerror・参照モデル・use caseの型だけを使い、Repository・tableを使わない", () => {
  const allowed: [typeof workFiles, Set<string>][] = [
    [directionFiles, new Set(["ProjectArchivedError", "ProjectDetail", "ProjectStatus"])],
    [workFiles, new Set(["ProjectArchivedError"])],
    [
      accessFiles,
      new Set([
        "ProjectArchivedError",
        "GetProjectUseCase",
        "ListProjectsUseCase",
        "ProjectDetail",
        "ProjectStatus",
        "WorkspaceArchivedError",
        "GetWorkspaceUseCase",
        "ListWorkspacesUseCase",
        "CreateWorkspaceProjectUseCase",
        "Workspace",
        "WorkspaceStatus",
      ]),
    ],
  ];
  for (const [files, names] of allowed) {
    for (const file of files) {
      for (const specifier of importsOf(file.text)) {
        assert.ok(!specifier.startsWith("@compass/organization/"), `${file.name} がOrganizationの内部 ${specifier} をimportしている`);
      }
      for (const name of importedNames(file.text, "@compass/organization")) {
        assert.ok(names.has(name), `${file.name} がOrganizationの ${name} を使っている`);
      }
    }
  }
});

test("Direction・Work・Accessのdomainはframework・DB client・application層に依存しない", () => {
  const domainFiles = [...workFiles, ...directionFiles, ...accessFiles].filter((file) => file.name.includes("/src/domain/"));
  assert.ok(domainFiles.length > 10, "domainのソースを走査できている");
  for (const file of domainFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.match(specifier, /^\.\/[A-Za-z]+\.ts$/, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Activityはactivity tableだけを読み書きし、他のContext・serverのpackageに依存しない（Projectの状態・認可はportで受け取る）", () => {
  const queried = new Set(activityFiles.flatMap((file) => tablesQueriedIn(file.text)));
  assert.ok(queried.has("activity"), "走査が空振りしていない");
  assert.deepEqual([...queried].filter((table) => table !== "activity"), []);
  for (const file of activityFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/(?!shared$)/, `${file.name} が ${specifier} をimportしている`);
      assert.doesNotMatch(specifier, /(?:\.\.\/)+server\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of activityFiles.filter((file) => !file.name.includes("/infrastructure/") && !file.name.endsWith("/src/index.ts"))) {
    for (const specifier of importsOf(file.text)) {
      assert.notEqual(specifier, "kysely", `${file.name} がKyselyをimportしている`);
      assert.doesNotMatch(specifier, /infrastructure\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of activityFiles.filter((file) => file.name.includes("/src/domain/"))) {
    assert.deepEqual(importsOf(file.text), [], `${file.name} がimportしている`);
  }
  // 他のContextもActivityのtableを直接扱わない（canonical生成はserverがActivityの公開関数へ渡す）。
  for (const file of [...workFiles, ...directionFiles, ...accessFiles, ...sharedFiles]) {
    assert.deepEqual(tablesQueriedIn(file.text).filter((table) => table === "activity"), [], `${file.name} がactivityを直接使っている`);
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/activity/, `${file.name} が ${specifier} をimportしている`);
    }
  }
});

test("Organizationは自身のtableだけを読み書きし、sharedだけに依存する。他ContextもWorkspace・Projectのtableを直接使わない", () => {
  const organizationTables = [
    "workspace",
    "workspace_principle",
    "workspace_constraint",
    "project",
    "project_principle",
    "project_constraint",
    "project_repository_link",
    "project_resource",
  ];
  const queried = new Set(organizationFiles.flatMap((file) => tablesQueriedIn(file.text)));
  assert.ok(queried.has("workspace") && queried.has("project") && queried.has("project_resource"), "走査が空振りしていない");
  assert.deepEqual([...queried].filter((table) => !organizationTables.includes(table)), []);
  for (const file of organizationFiles) {
    for (const specifier of importsOf(file.text)) {
      assert.doesNotMatch(specifier, /^@compass\/(?!shared$)/, `${file.name} が ${specifier} をimportしている`);
      assert.doesNotMatch(specifier, /(?:\.\.\/)+server\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of organizationFiles.filter((file) => !file.name.includes("/infrastructure/") && !file.name.endsWith("/src/index.ts"))) {
    for (const specifier of importsOf(file.text)) {
      assert.notEqual(specifier, "kysely", `${file.name} がKyselyをimportしている`);
      assert.doesNotMatch(specifier, /infrastructure\//, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of organizationFiles.filter((file) => file.name.includes("/src/domain/"))) {
    for (const specifier of importsOf(file.text)) {
      assert.match(specifier, /^\.\/[A-Za-z]+\.ts$/, `${file.name} が ${specifier} をimportしている`);
    }
  }
  for (const file of [...workFiles, ...directionFiles, ...accessFiles, ...activityFiles, ...sharedFiles]) {
    const touched = tablesQueriedIn(file.text).filter((table) => organizationTables.includes(table));
    assert.deepEqual(touched, [], `${file.name} がOrganizationのtableを直接使っている`);
  }
});

test("Work・Directionの連携に、別Wacha server・localhost HTTP・内部loopbackを使わない", () => {
  for (const file of [...serverFiles, ...workFiles, ...directionFiles, ...accessFiles]) {
    assert.doesNotMatch(file.text, /\bfetch\(\s*["'`]https?:\/\/(?:localhost|127\.0\.0\.1)/, `${file.name} がloopback HTTPを呼んでいる`);
    assert.doesNotMatch(file.text, /StreamableHTTPClientTransport|createMcpClient|new Client\(/, `${file.name} が内部MCPクライアントを使っている`);
  }
  const server = readFileSync(join(repositoryRoot, "server/src/main.ts"), "utf-8");
  // 起動するserverは一つ（同一Hono・同一port）。
  assert.equal([...server.matchAll(/\bserve\(/g)].length, 1);
});
