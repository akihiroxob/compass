import assert from "node:assert/strict";
import test, { beforeEach } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import { ConflictError, ValidationError } from "@compass/shared";
import { CoordinationError } from "../src/application/error/CoordinationError.ts";
import type { RevisionGateway } from "../src/application/port/RevisionGateway.ts";
import { ListProjectReleasesUseCase, RecordPublicationUseCase } from "../src/application/PublicationUseCases.ts";
import type { GitHubRepositoryName } from "../src/domain/PullRequest.ts";
import { TaskStatus } from "../src/domain/TaskStatus.ts";
import { GitHubPullRequestGateway } from "../src/infrastructure/GitHubPullRequestGateway.ts";
import { initializeWorkSchema } from "../src/infrastructure/initializeWorkSchema.ts";
import { KyselyWorkStore } from "../src/infrastructure/KyselyWorkStore.ts";
import type { WorkDatabase } from "../src/infrastructure/schema.ts";

/**
 * 公開確認（Runtimeの原記録）とリリース履歴の判定。開発の受入・PRのmerge・公開を別の事実として扱い、mergeや受入だけで公開済みにしない。
 * Repositoryの履歴は制御可能なfake gateway（commitの祖先関係）で置き換え、GitHubのcompare応答の解釈はadapterで別に確認する。
 */
const sha = (digit: string) => digit.repeat(40);

/** 線形の履歴（`history`の順に先祖→子孫）と、そこから外れたcommit（分岐）を持つRepository。 */
class FakeHistory implements RevisionGateway {
  history: string[] = [];
  branch = new Set<string>();
  failure: CoordinationError | null = null;
  compares = 0;

  async commitExists(_repository: GitHubRepositoryName, commit: string) {
    if (this.failure) throw this.failure;
    return this.history.includes(commit) || this.branch.has(commit);
  }

  async containsCommit(_repository: GitHubRepositoryName, base: string, head: string) {
    this.compares += 1;
    if (this.failure) throw this.failure;
    if (this.branch.has(base) || this.branch.has(head)) return base === head;
    const [b, h] = [this.history.indexOf(base), this.history.indexOf(head)];
    if (b < 0 || h < 0) return null;
    return b <= h;
  }
}

const openDatabase = () => {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<WorkDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
};

let database = openDatabase();
let history = new FakeHistory();
let now = 10_000;
let sourceConfigured = true;
let archived = false;
const projectId = "project-a";
const repositoryId = "repo-a";
const otherRepositoryId = "repo-local";

const store = () => new KyselyWorkStore(database, () => ({
  grants: { listRoles: async () => [] },
  projects: {
    exists: async (id) => id === projectId,
    isArchived: async () => archived,
    findRepository: async (id, repo) => id !== projectId ? null
      : repo === repositoryId ? { id: repo, url: "https://github.com/acme/widget" }
        : repo === otherRepositoryId ? { id: repo, url: "https://example.test/local.git" } : null,
    findRequiredChecks: async () => [],
  },
  outcomeTargets: { isTarget: async () => false },
}));
const record = (principalId = "deployer", input: Record<string, unknown> = {}) =>
  new RecordPublicationUseCase(store(), history, () => now).execute(principalId, projectId, {
    repositoryId, revision: sha("c"), target: "production", observedAt: now - 1,
    evidence: [{ kind: "deployment", uri: "https://deploy.example.test/runs/1" }], ...input,
  });
const releases = () => new ListProjectReleasesUseCase(store(), async () => sourceConfigured).execute(projectId);

beforeEach(async () => {
  await database.destroy();
  database = openDatabase();
  await sql`create table project (id text primary key)`.execute(database);
  await sql`insert into project (id) values (${projectId})`.execute(database);
  await initializeWorkSchema(database);
  history = new FakeHistory();
  history.history = [sha("1"), sha("a"), sha("b"), sha("c"), sha("d")];
  now = 10_000;
  sourceConfigured = true;
  archived = false;
});

let sequence = 0;
/** Task（Story付き）と現在のPR、受入済みならTASK_ACCEPTEDのChange。 */
const seedTask = async (title: string, options: {
  status?: TaskStatus; pr?: { number: number; state: "open" | "merged"; mergeSha?: string | null; acceptedMergeSha?: string | null };
  deliverables?: { repositoryId: string; commitSha: string }[];
}) => {
  sequence += 1;
  const taskId = `task-${title}`;
  const storyId = `story-${title}`;
  await database.insertInto("story").values({ id: storyId, project_id: projectId, title: `Story ${title}`, description: null, status: "doing",
    sort_order: sequence, created_at: sequence, updated_at: sequence, outcome_ref: "outcome-1", origin_decision_id: null,
    success_criteria_snapshot: null, constraints_snapshot: null, repository_snapshot: null, correlation_id: null }).execute();
  const status = options.status ?? TaskStatus.ACCEPTED;
  await database.insertInto("task").values({ id: taskId, project_id: projectId, story_id: storyId, title, description: null, status,
    assignee: null, reject_reason: null, resume_source_status: null, sort_order: sequence, created_at: sequence, updated_at: sequence, task_key: null }).execute();
  if (options.pr) {
    const merged = options.pr.state === "merged";
    await database.insertInto("task_pull_request").values({
      id: `pr-${title}`, task_id: taskId, project_id: projectId, repository_id: repositoryId, repository: "acme/widget", number: options.pr.number,
      sequence: 1, url: `https://github.com/acme/widget/pull/${options.pr.number}`, state: options.pr.state, draft: 0, head_branch: title,
      head_sha: sha("f"), base_branch: "main", merge_sha: merged ? options.pr.mergeSha ?? null : null, author: "agent-bot",
      work_claim_id: "claim", principal_id: "worker-a", verified_at: sequence, reviewed_head_sha: merged ? sha("f") : null,
      review_comment_id: null, review_comment_url: null, accepted_merge_sha: options.pr.acceptedMergeSha ?? null, acceptance_evidence: null,
      created_at: sequence, updated_at: sequence,
    }).execute();
  }
  if (status === TaskStatus.ACCEPTED) {
    await database.insertInto("change_log").values({ project_id: projectId, type: "TASK_ACCEPTED", entity_id: taskId, principal_id: "manager-a",
      claim_id: null, occurred_at: 1_000 + sequence, payload: JSON.stringify({
        ...(options.deliverables ? { deliverables: options.deliverables.map((d) => ({ ...d, paths: ["README.md"], pullRequestUrl: null })) } : {}),
      }) }).execute();
  }
  return taskId;
};

const changeOf = async (taskId: string) => {
  const change = (await releases()).changes.find((candidate) => candidate.task.id === taskId);
  assert.ok(change, `change ${taskId} is listed`);
  return change;
};

test("受入済み・merge済みでも公開記録がなければ公開済みにせず、入力元の設定がなければ確認できず（not_configured）とする", async () => {
  const accepted = await seedTask("accepted", { pr: { number: 1, state: "merged", mergeSha: sha("a"), acceptedMergeSha: sha("a") } });
  const unmerged = await seedTask("unmerged", { status: TaskStatus.IN_REVIEW, pr: { number: 2, state: "open" } });
  await seedTask("no-change", {});

  sourceConfigured = false;
  const before = await releases();
  assert.deepEqual(before.publicationSource, { configured: false, sourceConfigured: false, recordCount: 0 });
  assert.deepEqual(before.changes.map((change) => change.task.id).sort(), [accepted, unmerged].sort(), "PR・受入成果物のないTaskは変更に含めない");
  const notConfigured = before.changes.find((change) => change.task.id === accepted)!;
  assert.equal(notConfigured.development.status, "accepted");
  assert.deepEqual([notConfigured.publication.status, notConfigured.publication.reason], ["unconfirmed", "not_configured"]);

  sourceConfigured = true;
  const configured = await changeOf(accepted);
  assert.deepEqual([configured.publication.status, configured.publication.reason], ["unconfirmed", "no_record"], "mergeだけで公開としない");
  assert.deepEqual(configured.revisions, [{ repositoryId, commitSha: sha("a"), source: "pull_request_merge" }]);
  assert.deepEqual(configured.story, { id: "story-accepted", title: "Story accepted", outcomeId: "outcome-1" }, "Outcomeへ辿れる");
  assert.equal(configured.pullRequest?.url, "https://github.com/acme/widget/pull/1");
  const open = await changeOf(unmerged);
  assert.deepEqual([open.development.status, open.publication.status, open.publication.reason], ["not_accepted", "unconfirmed", "no_revision"]);
});

test("1件の公開記録に複数Taskの変更が含まれ、含まれない新しいmergeは未公開、記録後に判明したmergeは確認できずと区別する", async () => {
  const first = await seedTask("first", { pr: { number: 1, state: "merged", mergeSha: sha("a"), acceptedMergeSha: sha("a") } });
  const second = await seedTask("second", { pr: { number: 2, state: "merged", mergeSha: sha("b"), acceptedMergeSha: sha("b") } });
  const later = await seedTask("later", { pr: { number: 3, state: "merged", mergeSha: sha("d") } });
  const deliverable = await seedTask("deliverable", { deliverables: [{ repositoryId, commitSha: sha("C") }] });

  const result = await record("deployer", { revision: sha("c"), method: "cloudflare-pages", targetUrl: "https://app.example.test" });
  assert.equal(result.recorded, true);
  assert.equal(result.superseded, false);
  assert.deepEqual(result.publication.includedCommits, [sha("a"), sha("b"), sha("c")].sort());
  assert.deepEqual(result.publication.notIncludedCommits, [sha("d")]);
  assert.equal(result.publication.principalId, "deployer");

  for (const taskId of [first, second, deliverable]) {
    const change = await changeOf(taskId);
    assert.equal(change.publication.status, "published", taskId);
    assert.equal(change.publication.publishedAt, now - 1);
    assert.deepEqual(change.publication.targets.map((target) => [target.target, target.latestRecordId, target.publishedRecordId]),
      [["production", result.publication.id, result.publication.id]]);
  }
  const notYet = await changeOf(later);
  assert.equal(notYet.development.status, "accepted");
  assert.deepEqual([notYet.publication.status, notYet.publication.reason], ["not_published", null], "受入済みでも公開revisionに含まれなければ未公開");

  // 記録の後でmergeが判明した変更は、その記録で判定していないため確認できず（未公開・公開済みに分類しない）。
  const discovered = await seedTask("discovered", { status: TaskStatus.WAIT_ACCEPT, pr: { number: 4, state: "merged", mergeSha: sha("1") } });
  const unknown = await changeOf(discovered);
  assert.deepEqual([unknown.development.status, unknown.publication.status, unknown.publication.reason], ["not_accepted", "unconfirmed", "not_compared"]);

  const listed = await releases();
  assert.deepEqual(listed.publicationSource, { configured: true, sourceConfigured: true, recordCount: 1 });
  assert.deepEqual(listed.publications.map((publication) => [publication.id, publication.current, publication.method, publication.targetUrl]),
    [[result.publication.id, true, "cloudflare-pages", "https://app.example.test/"]]);
});

test("対象revisionの不一致・古い通知・再送で誤った成果版を公開済みにせず、原記録はすべて残す", async () => {
  const task = await seedTask("task", { pr: { number: 1, state: "merged", mergeSha: sha("c"), acceptedMergeSha: sha("c") } });
  history.branch.add(sha("e"));

  // 分岐したrevision（対象Commitを含まない）の公開は未公開。
  now = 20_000;
  const diverged = await record("deployer", { revision: sha("e"), observedAt: 19_000 });
  assert.deepEqual(diverged.publication.notIncludedCommits, [sha("c")]);
  assert.equal((await changeOf(task)).publication.status, "not_published");

  // 正しいrevisionの新しい確認で公開済みになる。
  const published = await record("deployer", { revision: sha("d"), observedAt: 19_500 });
  assert.equal((await changeOf(task)).publication.status, "published");

  // 後から届いた古い通知（より前の確認日時、対象を含まないrevision）は原記録に残すが、現在の状況を戻さない。
  const stale = await record("deployer", { revision: sha("b"), observedAt: 18_000 });
  assert.equal(stale.recorded, true);
  assert.equal(stale.superseded, true);
  const change = await changeOf(task);
  assert.deepEqual([change.publication.status, change.publication.publishedAt, change.publication.targets[0]!.latestRecordId],
    ["published", 19_500, published.publication.id]);

  // 同じ公開先・revision・確認日時の再送は同じ記録を返し、GitHubを読み直さない。内容が違えば上書きしない。
  const compares = history.compares;
  const resent = await record("deployer", { revision: sha("d"), observedAt: 19_500 });
  assert.deepEqual([resent.recorded, resent.publication.id], [false, published.publication.id]);
  assert.equal(history.compares, compares);
  await assert.rejects(
    record("deployer", { revision: sha("d"), observedAt: 19_500, evidence: [{ kind: "ci", uri: "https://ci.example.test/2" }] }),
    (error) => error instanceof ConflictError && error.details.publicationId === published.publication.id,
  );

  // 別の公開先は独立に判定し、stagingだけの公開は公開先ごとに区別できる。
  await record("deployer", { revision: sha("b"), observedAt: 19_600, target: "staging" });
  const targets = (await changeOf(task)).publication.targets.map((target) => [target.target, target.status]);
  assert.deepEqual(targets, [["production", "published"], ["staging", "not_published"]]);

  // ロールバック（後の確認日時で対象を含まないrevision）は未公開に戻る。
  await record("deployer", { revision: sha("b"), observedAt: 19_900 });
  assert.deepEqual((await changeOf(task)).publication.targets.map((target) => target.status), ["not_published", "not_published"]);

  assert.equal((await releases()).publications.length, 5, "古い通知・ロールバックを含む原記録をすべて保持する");
  assert.deepEqual((await releases()).publications.map((publication) => publication.id).includes(diverged.publication.id), true);
});

test("Repositoryに無いrevision・GitHubを読めない場合・入力不正・未来の確認日時・archived・未登録Repositoryは記録しない", async () => {
  await seedTask("task", { pr: { number: 1, state: "merged", mergeSha: sha("c") } });
  await assert.rejects(record("deployer", { revision: sha("9") }),
    (error) => error instanceof ValidationError && error.issues.some((issue) => issue.path === "revision"));
  history.failure = new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned HTTP 502");
  await assert.rejects(record(), (error) => error instanceof CoordinationError && error.code === "GITHUB_UNAVAILABLE" && error.retryable);
  history.failure = null;
  await assert.rejects(record("deployer", { observedAt: now + 1 }),
    (error) => error instanceof ValidationError && error.issues.some((issue) => issue.path === "observedAt"));
  await assert.rejects(record("deployer", { revision: "abc", evidence: [], target: "" }),
    (error) => error instanceof ValidationError && ["revision", "evidence", "target"].every((path) => error.issues.some((issue) => issue.path === path)));
  await assert.rejects(record("deployer", { evidence: [{ kind: "url", uri: "https://user:secret@example.test/" }] }),
    (error) => error instanceof ValidationError && error.issues.some((issue) => issue.path === "evidence.0.uri"));
  await assert.rejects(record("deployer", { repositoryId: "repo-other" }),
    (error) => error instanceof ValidationError && error.issues.some((issue) => issue.path === "repositoryId"));
  archived = true;
  await assert.rejects(record(), ConflictError);
  archived = false;
  assert.equal((await releases()).publications.length, 0);

  // GitHub以外のRepositoryは同一SHAだけを含むと判定し、GitHubを読まない。
  await seedTask("local", { deliverables: [{ repositoryId: otherRepositoryId, commitSha: sha("7") }] });
  history.failure = new CoordinationError("GITHUB_UNAVAILABLE", "must not be read");
  const local = await record("deployer", { repositoryId: otherRepositoryId, revision: sha("7") });
  assert.deepEqual(local.publication.includedCommits, [sha("7")]);
  assert.equal((await changeOf("task-local")).publication.status, "published");
});

test("GitHubのcompare・commit応答を包含関係に変換し、無いcommitは判定せず、不正な応答と障害は記録しない失敗にする", async () => {
  const responses = new Map<string, { status: number; body?: unknown }>([
    [`/repos/acme/widget/compare/${sha("a")}...${sha("c")}`, { status: 200, body: { status: "ahead" } }],
    [`/repos/acme/widget/compare/${sha("c")}...${sha("c")}`, { status: 200, body: { status: "identical" } }],
    [`/repos/acme/widget/compare/${sha("d")}...${sha("c")}`, { status: 200, body: { status: "behind" } }],
    [`/repos/acme/widget/compare/${sha("e")}...${sha("c")}`, { status: 200, body: { status: "diverged" } }],
    [`/repos/acme/widget/compare/${sha("9")}...${sha("c")}`, { status: 404 }],
    [`/repos/acme/widget/compare/${sha("8")}...${sha("c")}`, { status: 200, body: { status: "unknown" } }],
    [`/repos/acme/widget/compare/${sha("7")}...${sha("c")}`, { status: 502 }],
    [`/repos/acme/widget/commits/${sha("c")}`, { status: 200, body: { sha: sha("c") } }],
    [`/repos/acme/widget/commits/${sha("9")}`, { status: 422 }],
  ]);
  const gateway = new GitHubPullRequestGateway({
    apiBaseUrl: "https://api.github.test",
    request: async (url) => {
      const { pathname } = new URL(String(url));
      const response = responses.get(pathname) ?? { status: 404 };
      return new Response(response.body === undefined ? null : JSON.stringify(response.body), { status: response.status });
    },
  });
  const repository = { owner: "acme", name: "widget" };
  assert.deepEqual(await Promise.all([sha("a"), sha("c"), sha("d"), sha("e"), sha("9")].map((base) => gateway.containsCommit(repository, base, sha("c")))),
    [true, true, false, false, null]);
  await assert.rejects(gateway.containsCommit(repository, sha("8"), sha("c")), (error) => error instanceof CoordinationError && error.code === "GITHUB_UNAVAILABLE");
  await assert.rejects(gateway.containsCommit(repository, sha("7"), sha("c")), (error) => error instanceof CoordinationError && error.code === "GITHUB_UNAVAILABLE");
  assert.equal(await gateway.commitExists(repository, sha("c")), true);
  assert.equal(await gateway.commitExists(repository, sha("9")), false);
});

test("同じ確認日時・同じ受付時刻の通知は永続化した受付順で判定し、UUIDの大小に依存しない（異なるrevision・ロールバック・再送）", async () => {
  const task = await seedTask("task", { pr: { number: 1, state: "merged", mergeSha: sha("c"), acceptedMergeSha: sha("c") } });
  history.history = [sha("1"), sha("a"), sha("b"), sha("c"), sha("d")];
  now = 20_000;
  const same = { observedAt: 19_000 };
  const currentRevisions = async () => (await releases()).publications.filter((publication) => publication.current).map((publication) => publication.revision);

  // 受付順の2件目のUUIDが小さくなるようにしても、後に受け付けた記録が現在になる。
  const originalUuid = crypto.randomUUID;
  const uuids = ["ffffffff-ffff-4fff-8fff-ffffffffffff", "00000000-0000-4000-8000-000000000000"];
  try {
    (crypto as { randomUUID: () => string }).randomUUID = () => uuids.shift() ?? originalUuid.call(crypto);
    const first = await record("deployer", { ...same, revision: sha("b") });
    const second = await record("deployer", { ...same, revision: sha("c") });
    assert.deepEqual([first.superseded, second.superseded], [false, false]);
  } finally {
    (crypto as { randomUUID: () => string }).randomUUID = originalUuid;
  }
  assert.deepEqual(await currentRevisions(), [sha("c")], "後から受け付けた記録が現在");
  assert.equal((await changeOf(task)).publication.status, "published");

  // 同時刻のロールバック通知（対象を含まないrevision）は、後に受け付ければ未公開に戻る。
  await record("deployer", { ...same, revision: sha("a") });
  assert.equal((await changeOf(task)).publication.status, "not_published");

  // 古い再送は新しい記録を戻さず、順序も変えない。
  const resent = await record("deployer", { ...same, revision: sha("c") });
  assert.equal(resent.recorded, false);
  assert.equal(resent.superseded, true);
  assert.equal((await changeOf(task)).publication.status, "not_published");
  assert.deepEqual(await currentRevisions(), [sha("a")]);
});
