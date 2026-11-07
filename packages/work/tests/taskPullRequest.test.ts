import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after, beforeEach } from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import { CoordinationError } from "../src/application/error/CoordinationError.ts";
import type { DirectionReferenceLookupPort } from "../src/application/port/DirectionReferenceLookupPort.ts";
import type { PullRequestGateway } from "../src/application/port/PullRequestGateway.ts";
import { TaskCoordinationService } from "../src/application/TaskCoordinationService.ts";
import { parseGitHubRepositoryUrl, type GitHubRepositoryName, type PullRequestSnapshot } from "../src/domain/PullRequest.ts";
import { TaskStatus } from "../src/domain/TaskStatus.ts";
import { WorkRole } from "../src/domain/WorkRole.ts";
import { GitHubPullRequestGateway } from "../src/infrastructure/GitHubPullRequestGateway.ts";
import { initializeWorkSchema } from "../src/infrastructure/initializeWorkSchema.ts";
import { KyselyWorkStore } from "../src/infrastructure/KyselyWorkStore.ts";
import type { WorkDatabase } from "../src/infrastructure/schema.ts";

/**
 * TaskへのPR登録・一覧（Claim・Project Grant・Repository・requestId・GitHubの確認結果）。GitHubは制御可能なfake gatewayで置き換え、
 * GitHub REST APIの応答の解釈（HTTP状態・不正な応答の区別）はloopbackのGitHub互換serverでadapterごと確認する。
 */
const noDirectionReferences: DirectionReferenceLookupPort = {
  getProjectExecutionContext: async () => assert.fail("PR登録でDirectionを読んではならない"),
  getOutcomeSnapshot: async () => assert.fail("PR登録でOutcomeを読んではならない"),
};

const sha = (digit: string) => digit.repeat(40);

/** GitHubの状態を差し替えられるgateway。`failure`を設定すると、その読取を失敗させる。 */
class FakeGitHub implements PullRequestGateway {
  pulls = new Map<string, PullRequestSnapshot>();
  failure: CoordinationError | null = null;
  reads = 0;

  put(repository: string, number: number, patch: Partial<PullRequestSnapshot> = {}) {
    this.pulls.set(`${repository}#${number}`, {
      repository, number, url: `https://github.com/${repository}/pull/${number}`, state: "open", draft: false,
      headBranch: `task-${number}`, headSha: sha("a"), baseBranch: "main", mergeSha: null, author: "agent-bot", ...patch,
    });
  }

  async getPullRequest(repository: GitHubRepositoryName, number: number): Promise<PullRequestSnapshot> {
    this.reads += 1;
    if (this.failure) throw this.failure;
    const pr = this.pulls.get(`${repository.owner}/${repository.name}`.toLowerCase() + `#${number}`);
    if (!pr) throw new CoordinationError("PULL_REQUEST_NOT_FOUND", "not found");
    return pr;
  }

  async listReviewEvidence() {
    return assert.fail("PR登録でレビュー根拠を読んではならない");
  }

  async listChecks() {
    return assert.fail("PR登録でCI結果を読んではならない");
  }
}

const openDatabase = () => {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<WorkDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
};

let database = openDatabase();
let grants = new Map<string, Set<string>>();
let archived = new Set<string>();
let repositories = new Map<string, { id: string; url: string }>();
let github = new FakeGitHub();
let now = 1_000;
const key = (projectId: string, principalId: string) => `${projectId}\u0000${principalId}`;
const createService = (gateway: PullRequestGateway | null = github) =>
  new TaskCoordinationService(
    new KyselyWorkStore(database, () => ({
      grants: { listRoles: async (projectId, principalId) => [...(grants.get(key(projectId, principalId)) ?? [])] },
      projects: {
        exists: async () => true,
        isArchived: async (projectId) => archived.has(projectId),
        findRepository: async (projectId, repositoryId) => repositories.get(`${projectId}:${repositoryId}`) ?? null,
        findRequiredChecks: async (projectId, repositoryId) => (repositories.has(`${projectId}:${repositoryId}`) ? [] : null),
      },
      outcomeTargets: { isTarget: async () => assert.fail("PR登録でOutcome Targetを読んではならない") },
    })),
    noDirectionReferences,
    () => now,
    60_000,
    gateway,
  );
let service = createService();

beforeEach(async () => {
  await database.destroy();
  database = openDatabase();
  await sql`create table project (id text primary key)`.execute(database);
  await initializeWorkSchema(database);
  grants = new Map();
  archived = new Set();
  repositories = new Map();
  github = new FakeGitHub();
  now = 1_000;
  service = createService();
});

const grant = (projectId: string, principalId: string, role: WorkRole) =>
  grants.set(key(projectId, principalId), new Set([...(grants.get(key(projectId, principalId)) ?? []), role]));

const hasCode = (code: string) => (error: unknown) => error instanceof CoordinationError && error.code === code;

/** Project・GitHub Repository・doingのTask（worker-aのWork Claim）。 */
const setup = async (repositoryUrl = "https://github.com/Acme/Widget") => {
  const projectId = crypto.randomUUID();
  await sql`insert into project (id) values (${projectId})`.execute(database);
  const repositoryId = `repo-${projectId.slice(0, 8)}`;
  repositories.set(`${projectId}:${repositoryId}`, { id: repositoryId, url: repositoryUrl });
  const taskId = crypto.randomUUID();
  await database.insertInto("task").values({ id: taskId, project_id: projectId, story_id: null, title: "Task", description: null,
    status: TaskStatus.TODO, assignee: null, reject_reason: null, resume_source_status: null, sort_order: 1, created_at: now, updated_at: now, task_key: null }).execute();
  grant(projectId, "worker-a", WorkRole.WORKER);
  const claim = await service.claimTask("worker-a", taskId, `claim-${taskId}`);
  return { projectId, repositoryId, taskId, claimId: claim.claimId };
};

const register = (context: Awaited<ReturnType<typeof setup>>, number: number, requestId: string, principalId = "worker-a") =>
  service.registerTaskPullRequest(principalId, { taskId: context.taskId, claimId: context.claimId, repositoryId: context.repositoryId, number }, requestId);

const changeCount = async (type: string) =>
  Number((await database.selectFrom("change_log").select(({ fn }) => fn.countAll().as("n")).where("type", "=", type).executeTakeFirstOrThrow()).n);

test("open PRを現在のWork Claimで登録すると、番号・URL・head / base / merge・確認時刻を保存し、Task別の履歴で読める", async () => {
  const context = await setup();
  github.put("acme/widget", 7, { headSha: sha("b") });
  now = 2_000;
  const { pullRequest } = await register(context, 7, "pr-1");
  assert.deepEqual(
    { repository: pullRequest.repository, number: pullRequest.number, url: pullRequest.url, state: pullRequest.state, draft: pullRequest.draft,
      headBranch: pullRequest.headBranch, headSha: pullRequest.headSha, baseBranch: pullRequest.baseBranch, mergeSha: pullRequest.mergeSha,
      verifiedAt: pullRequest.verifiedAt, workClaimId: pullRequest.workClaimId, repositoryId: pullRequest.repositoryId, current: pullRequest.current },
    { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7", state: "open", draft: false,
      headBranch: "task-7", headSha: sha("b"), baseBranch: "main", mergeSha: null, verifiedAt: 2_000, workClaimId: context.claimId,
      repositoryId: context.repositoryId, current: true },
  );
  grant(context.projectId, "reviewer-a", WorkRole.REVIEWER);
  const listed = await service.listTaskPullRequests("reviewer-a", context.taskId);
  assert.deepEqual(listed.pullRequests.map((pr) => [pr.number, pr.headSha, pr.current]), [[7, sha("b"), true]]);
  assert.equal(await changeCount("TASK_PULL_REQUEST_REGISTERED"), 1);
});

test("同じrequestIdの再送はGitHubを読み直さず保存済みの結果を返し、行もChangeも増やさない。入力が違えばIDEMPOTENCY_CONFLICT", async () => {
  const context = await setup();
  github.put("acme/widget", 7);
  const first = await register(context, 7, "pr-1");
  const reads = github.reads;
  github.failure = new CoordinationError("GITHUB_UNAVAILABLE", "down");
  const again = await register(context, 7, "pr-1");
  assert.deepEqual(again, first);
  assert.equal(github.reads, reads, "受付記録があればGitHubを読まない");
  assert.equal((await service.listTaskPullRequests("worker-a", context.taskId)).pullRequests.length, 1);
  assert.equal(await changeCount("TASK_PULL_REQUEST_REGISTERED"), 1);
  await assert.rejects(register(context, 8, "pr-1"), hasCode("IDEMPOTENCY_CONFLICT"));
});

test("同じPRの再登録は同じ行の事実（head・確認時刻）を更新し、確認の履歴はChangeに残る", async () => {
  const context = await setup();
  github.put("acme/widget", 7);
  await register(context, 7, "pr-1");
  github.put("acme/widget", 7, { headSha: sha("c") });
  now = 5_000;
  const { pullRequest } = await register(context, 7, "pr-2");
  assert.equal(pullRequest.headSha, sha("c"));
  assert.equal(pullRequest.verifiedAt, 5_000);
  const listed = await service.listTaskPullRequests("worker-a", context.taskId);
  assert.equal(listed.pullRequests.length, 1);
  assert.equal(await changeCount("TASK_PULL_REQUEST_REGISTERED"), 2);
});

test("別のPRは現在のopen PRがGitHubでclose済みになってから登録でき、履歴の最後が現在のPRになる", async () => {
  const context = await setup();
  github.put("acme/widget", 7);
  github.put("acme/widget", 9);
  await register(context, 7, "pr-1");
  await assert.rejects(register(context, 9, "pr-2"), hasCode("PULL_REQUEST_NOT_READY"));
  github.put("acme/widget", 7, { state: "closed" });
  await register(context, 9, "pr-3");
  const listed = await service.listTaskPullRequests("worker-a", context.taskId);
  assert.deepEqual(listed.pullRequests.map((pr) => [pr.number, pr.state, pr.current]), [[7, "closed", false], [9, "open", true]]);
  // 置き換えられたPRは再び現在のPRにしない。
  github.put("acme/widget", 7, { state: "open" });
  await assert.rejects(register(context, 7, "pr-4"), hasCode("PULL_REQUEST_NOT_READY"));
});

test("draft・closed・merged、別Repository・別TaskのPRは登録しない", async () => {
  const context = await setup();
  github.put("acme/widget", 1, { draft: true });
  github.put("acme/widget", 2, { state: "closed" });
  github.put("acme/widget", 3, { state: "merged", mergeSha: sha("d") });
  for (const number of [1, 2, 3]) await assert.rejects(register(context, number, `pr-${number}`), hasCode("PULL_REQUEST_NOT_READY"));
  // GitHubが返したbase Repositoryが、登録したRepositoryと違う（fork等）。
  github.put("acme/widget", 4, { repository: "other/widget" });
  await assert.rejects(register(context, 4, "pr-4"), hasCode("PULL_REQUEST_NOT_READY"));

  const other = await setup();
  github.put("acme/widget", 5);
  await register(other, 5, "pr-5");
  await assert.rejects(register(context, 5, "pr-6"), hasCode("PULL_REQUEST_NOT_READY"), "同じPRは別Project・別Taskへ登録できない");
  assert.equal((await service.listTaskPullRequests("worker-a", context.taskId)).pullRequests.length, 0);
});

test("他ProjectのRepository・GitHub以外のURL・不正な番号はINVALID_INPUTで、GitHubを読まない", async () => {
  const context = await setup();
  const other = await setup();
  await assert.rejects(
    service.registerTaskPullRequest("worker-a", { taskId: context.taskId, claimId: context.claimId, repositoryId: other.repositoryId, number: 1 }, "x-1"),
    hasCode("INVALID_INPUT"),
  );
  const local = await setup("file:///tmp/verification-repo");
  await assert.rejects(register(local, 1, "x-2"), hasCode("INVALID_INPUT"));
  await assert.rejects(register(context, 0, "x-3"), hasCode("INVALID_INPUT"));
  await assert.rejects(register(context, 1.5, "x-4"), hasCode("INVALID_INPUT"));
  assert.equal(github.reads, 0);
});

test("古いClaim・他PrincipalのClaim・権限不足は拒否し、一覧はProjectのGrantが必要", async () => {
  const context = await setup();
  github.put("acme/widget", 7);
  await assert.rejects(register(context, 7, "y-1", "worker-b"), hasCode("CLAIM_NOT_OWNED"));
  grants.get(key(context.projectId, "worker-a"))!.delete(WorkRole.WORKER);
  grant(context.projectId, "worker-a", WorkRole.REVIEWER);
  await assert.rejects(register(context, 7, "y-2"), hasCode("FORBIDDEN"));
  grant(context.projectId, "worker-a", WorkRole.WORKER);
  await service.releaseClaim("worker-a", context.claimId, "stop", "release-1");
  await assert.rejects(register(context, 7, "y-3"), hasCode("CLAIM_EXPIRED"));

  const expiring = await setup();
  now += 60_001;
  await assert.rejects(register(expiring, 7, "y-4"), hasCode("CLAIM_EXPIRED"));
  assert.equal(github.reads, 0, "Claim・権限で拒否する登録はGitHubを読まない");

  await assert.rejects(service.listTaskPullRequests("outsider", context.taskId), hasCode("FORBIDDEN"));
});

test("GitHubを読めない失敗（retryable）と確定した失敗を区別し、どちらも何も保存しない。復旧後は同じrequestIdで登録できる", async () => {
  const context = await setup();
  github.put("acme/widget", 7);
  github.failure = new CoordinationError("GITHUB_UNAVAILABLE", "timeout");
  const unavailable = await register(context, 7, "z-1").catch((error: unknown) => error);
  assert.ok(unavailable instanceof CoordinationError);
  assert.equal(unavailable.code, "GITHUB_UNAVAILABLE");
  assert.equal(unavailable.retryable, true);
  github.failure = new CoordinationError("GITHUB_ACCESS_DENIED", "denied");
  const denied = await register(context, 7, "z-2").catch((error: unknown) => error);
  assert.ok(denied instanceof CoordinationError);
  assert.equal(denied.retryable, false);
  github.failure = null;
  await assert.rejects(register(context, 404, "z-3"), (error: unknown) => hasCode("PULL_REQUEST_NOT_FOUND")(error) && !(error as CoordinationError).retryable);
  assert.equal((await service.listTaskPullRequests("worker-a", context.taskId)).pullRequests.length, 0);
  assert.equal(await changeCount("TASK_PULL_REQUEST_REGISTERED"), 0);

  const { pullRequest } = await register(context, 7, "z-1");
  assert.equal(pullRequest.number, 7);
});

test("StoryにRepositoryがあれば、そのRepositoryのPRだけを登録できる", async () => {
  const context = await setup();
  const storyId = crypto.randomUUID();
  await database.insertInto("story").values({ id: storyId, project_id: context.projectId, title: "S", description: null, status: "doing",
    sort_order: 1, created_at: now, updated_at: now, outcome_ref: null, origin_decision_id: null, success_criteria_snapshot: null,
    constraints_snapshot: null, repository_snapshot: JSON.stringify({ id: "repo-docs", name: "docs", url: "https://github.com/acme/docs" }),
    correlation_id: null }).execute();
  await database.updateTable("task").set({ story_id: storyId }).where("id", "=", context.taskId).execute();
  github.put("acme/widget", 7);
  await assert.rejects(register(context, 7, "s-1"), hasCode("INVALID_INPUT"));
  assert.equal(github.reads, 0);
});

test("GitHub連携のないServerではPR登録をGITHUB_UNAVAILABLEで拒否する", async () => {
  service = createService(null);
  const context = await setup();
  await assert.rejects(register(context, 7, "n-1"), hasCode("GITHUB_UNAVAILABLE"));
});

test("受入成果物のPR URLは検証済みPRとして一覧に出ない", async () => {
  const context = await setup();
  grant(context.projectId, "reviewer-a", WorkRole.REVIEWER);
  grant(context.projectId, "manager-a", WorkRole.MANAGER);
  await service.addTaskComment("worker-a", context.taskId, context.claimId, "See https://github.com/acme/widget/pull/7", "c-1");
  await service.completeTask("worker-a", context.taskId, context.claimId, "done-1");
  const review = await service.claimReview("reviewer-a", context.taskId, "rv-1");
  await service.reviewedTask("reviewer-a", context.taskId, review.claimId, "rv-2");
  const acceptance = await service.claimAcceptance("manager-a", context.taskId, "ac-1");
  await service.acceptTask("manager-a", context.taskId, acceptance.claimId, "ac-2", [
    { repositoryId: context.repositoryId, commitSha: sha("e"), paths: ["README.md"], pullRequestUrl: "https://github.com/Acme/Widget/pull/7" },
  ]);
  assert.deepEqual((await service.listTaskPullRequests("manager-a", context.taskId)).pullRequests, []);
});

test("Repository URLはhttps://github.com/{owner}/{name}だけをGitHub Repositoryとして解釈する", () => {
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/Acme/Widget.git/"), { owner: "Acme", name: "Widget" });
  for (const url of ["http://github.com/a/b", "https://gitlab.com/a/b", "https://github.com/a", "https://github.com/a/b/tree/main",
    "https://token@github.com/a/b", "https://github.com/a/b?x=1", "/tmp/repo", "file:///tmp/repo"]) {
    assert.equal(parseGitHubRepositoryUrl(url), null, url);
  }
});

// GitHub REST API互換のloopback server。adapterのHTTP解釈（状態・不正な応答・timeout）を確認する。
let respond: (path: string) => { status: number; body?: unknown; headers?: Record<string, string>; delayMs?: number } = () => ({ status: 500 });
const requests: { path: string; authorization: string | undefined }[] = [];
const fakeApi: Server = createServer((request, response) => {
  requests.push({ path: request.url ?? "", authorization: request.headers.authorization });
  const answer = respond(request.url ?? "");
  setTimeout(() => {
    response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers });
    response.end(answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body));
  }, answer.delayMs ?? 0);
});
await new Promise<void>((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => fakeApi.close(() => resolve())));
const apiBaseUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`;

const gitHubPull = (patch: Record<string, unknown> = {}) => ({
  number: 7, html_url: "https://github.com/Acme/Widget/pull/7", state: "closed", draft: false, merged: true,
  merge_commit_sha: "F".repeat(40), user: { login: "agent-bot" }, head: { ref: "task-7", sha: "B".repeat(40) },
  base: { ref: "main", repo: { full_name: "Acme/Widget" } }, ...patch,
});

test("GitHub adapterはPRの事実を正規化し、tokenはAuthorizationにだけ使う", async () => {
  respond = () => ({ status: 200, body: gitHubPull() });
  requests.length = 0;
  const gateway = new GitHubPullRequestGateway({ apiBaseUrl, token: "secret-token" });
  const pr = await gateway.getPullRequest({ owner: "Acme", name: "Widget" }, 7);
  assert.deepEqual(pr, { repository: "acme/widget", number: 7, url: "https://github.com/Acme/Widget/pull/7", state: "merged", draft: false,
    headBranch: "task-7", headSha: "b".repeat(40), baseBranch: "main", mergeSha: "f".repeat(40), author: "agent-bot" });
  assert.deepEqual(requests, [{ path: "/repos/Acme/Widget/pulls/7", authorization: "Bearer secret-token" }]);
  assert.ok(!JSON.stringify(pr).includes("secret-token"));
});

test("GitHub adapterは404・401/403を確定失敗、rate limit・5xx・timeout・不正な応答をGITHUB_UNAVAILABLEにする", async () => {
  const gateway = new GitHubPullRequestGateway({ apiBaseUrl, timeoutMs: 200 });
  const codeOf = async (answer: ReturnType<typeof respond>) => {
    respond = () => answer;
    return gateway.getPullRequest({ owner: "acme", name: "widget" }, 7).then(() => "ok", (error: unknown) => (error as CoordinationError).code);
  };
  assert.equal(await codeOf({ status: 404, body: { message: "Not Found" } }), "PULL_REQUEST_NOT_FOUND");
  assert.equal(await codeOf({ status: 401 }), "GITHUB_ACCESS_DENIED");
  assert.equal(await codeOf({ status: 403 }), "GITHUB_ACCESS_DENIED");
  assert.equal(await codeOf({ status: 403, headers: { "x-ratelimit-remaining": "0" } }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 429 }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 502 }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 200, body: "not json" }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 200, body: gitHubPull({ number: 8 }) }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 200, body: gitHubPull({ head: { ref: "x", sha: "short" } }) }), "GITHUB_UNAVAILABLE");
  assert.equal(await codeOf({ status: 200, body: gitHubPull(), delayMs: 1_000 }), "GITHUB_UNAVAILABLE");
  // 200でもobjectでない本文・保存する事実の型が違う・欠落した応答は、確認済みの事実へ変換しない。
  for (const body of [null, [], 7, gitHubPull({ draft: "true" }), gitHubPull({ draft: undefined }), gitHubPull({ merged: "false" }),
    gitHubPull({ merged: undefined }), gitHubPull({ user: null }), gitHubPull({ base: { ref: "main", repo: null } }),
    gitHubPull({ merge_commit_sha: 1 }), gitHubPull({ state: "open" })]) {
    assert.equal(await codeOf({ status: 200, body: JSON.stringify(body) }), "GITHUB_UNAVAILABLE", JSON.stringify(body));
  }
  const unreachable = new GitHubPullRequestGateway({ apiBaseUrl: "http://127.0.0.1:9", timeoutMs: 500 });
  await assert.rejects(unreachable.getPullRequest({ owner: "a", name: "b" }, 1), hasCode("GITHUB_UNAVAILABLE"));
});
