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
import {
  formatReviewMarker,
  unsatisfiedRequiredChecks,
  type GitHubRepositoryName,
  type PullRequestCheck,
  type PullRequestReviewEvidence,
  type PullRequestSnapshot,
} from "../src/domain/PullRequest.ts";
import { TaskStatus } from "../src/domain/TaskStatus.ts";
import { WorkRole } from "../src/domain/WorkRole.ts";
import { GitHubPullRequestGateway } from "../src/infrastructure/GitHubPullRequestGateway.ts";
import { initializeWorkSchema } from "../src/infrastructure/initializeWorkSchema.ts";
import { KyselyWorkStore } from "../src/infrastructure/KyselyWorkStore.ts";
import type { WorkDatabase } from "../src/infrastructure/schema.ts";

/**
 * 完了・レビュー・受入でのPR / SHA照合（ADR 0005）。GitHubはPR・コメント・CI結果を差し替えられるfake gatewayで、
 * 変更後のhead・merge失敗（競合）・未merge・必須checkの有無・同じGitHubアカウントのコメントを準備する。
 * GitHub REST APIの応答の解釈（コメントの印・check run / commit status）はloopbackのGitHub互換serverでadapterごと確認する。
 */
const noDirectionReferences: DirectionReferenceLookupPort = {
  getProjectExecutionContext: async () => assert.fail("PR照合でDirectionを読んではならない"),
  getOutcomeSnapshot: async () => assert.fail("PR照合でOutcomeを読んではならない"),
};

const sha = (digit: string) => digit.repeat(40);

class FakeGitHub implements PullRequestGateway {
  pulls = new Map<string, PullRequestSnapshot>();
  comments = new Map<string, PullRequestReviewEvidence[]>();
  checks = new Map<string, PullRequestCheck[]>();
  failure: CoordinationError | null = null;
  reads = { pulls: 0, comments: 0, checks: 0 };

  put(number: number, patch: Partial<PullRequestSnapshot> = {}) {
    const previous = this.pulls.get(`acme/widget#${number}`);
    this.pulls.set(`acme/widget#${number}`, {
      repository: "acme/widget", number, url: `https://github.com/acme/widget/pull/${number}`, state: "open", draft: false,
      headBranch: `task-${number}`, headSha: sha("a"), baseBranch: "main", mergeSha: null, author: "agent-bot", ...previous, ...patch,
    });
  }

  /** Worker（PRの作成者）と同じGitHubアカウントでレビュー根拠のコメントを残す。 */
  comment(number: number, marker: Omit<PullRequestReviewEvidence, "commentId" | "url" | "author">) {
    const list = this.comments.get(`acme/widget#${number}`) ?? [];
    const commentId = 1000 + list.length + this.comments.size * 100;
    list.push({ commentId, url: `https://github.com/acme/widget/pull/${number}#issuecomment-${commentId}`, author: "agent-bot", ...marker });
    this.comments.set(`acme/widget#${number}`, list);
    return commentId;
  }

  async getPullRequest(repository: GitHubRepositoryName, number: number) {
    this.reads.pulls += 1;
    if (this.failure) throw this.failure;
    const pr = this.pulls.get(`${repository.owner}/${repository.name}#${number}`.toLowerCase());
    if (!pr) throw new CoordinationError("PULL_REQUEST_NOT_FOUND", "not found");
    return pr;
  }

  async listReviewEvidence(repository: GitHubRepositoryName, number: number) {
    this.reads.comments += 1;
    if (this.failure) throw this.failure;
    return this.comments.get(`${repository.owner}/${repository.name}#${number}`.toLowerCase()) ?? [];
  }

  async listChecks(_repository: GitHubRepositoryName, headSha: string) {
    this.reads.checks += 1;
    if (this.failure) throw this.failure;
    return this.checks.get(headSha) ?? [];
  }
}

const openDatabase = () => {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");
  return new Kysely<WorkDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
};

let database = openDatabase();
let grants = new Map<string, Set<string>>();
let repositories = new Map<string, { id: string; url: string; requiredChecks: string[] }>();
let github = new FakeGitHub();
let now = 1_000;
const key = (projectId: string, principalId: string) => `${projectId}\u0000${principalId}`;
const createService = () =>
  new TaskCoordinationService(
    new KyselyWorkStore(database, () => ({
      grants: { listRoles: async (projectId, principalId) => [...(grants.get(key(projectId, principalId)) ?? [])] },
      projects: {
        exists: async () => true,
        isArchived: async () => false,
        findRepository: async (projectId, repositoryId) => repositories.get(`${projectId}:${repositoryId}`) ?? null,
        findRequiredChecks: async (projectId, repositoryId) => repositories.get(`${projectId}:${repositoryId}`)?.requiredChecks ?? null,
      },
      outcomeTargets: { isTarget: async () => assert.fail("PR照合でOutcome Targetを読んではならない") },
    })),
    noDirectionReferences,
    () => now,
    60_000,
    github,
  );
let service = createService();

beforeEach(async () => {
  await database.destroy();
  database = openDatabase();
  await sql`create table project (id text primary key)`.execute(database);
  await initializeWorkSchema(database);
  grants = new Map();
  repositories = new Map();
  github = new FakeGitHub();
  now = 1_000;
  service = createService();
});

const grant = (projectId: string, principalId: string, role: WorkRole) =>
  grants.set(key(projectId, principalId), new Set([...(grants.get(key(projectId, principalId)) ?? []), role]));

const errorOf = async (promise: Promise<unknown>) => {
  const error = await promise.then(() => assert.fail("拒否されるはず"), (reason: unknown) => reason);
  assert.ok(error instanceof CoordinationError, String(error));
  return error;
};

/** Worker・Reviewer・Managerは別Principal。GitHubのアカウントはfakeで全員`agent-bot`（同じアカウント）。 */
const setup = async (requiredChecks: string[] = []) => {
  const projectId = crypto.randomUUID();
  await sql`insert into project (id) values (${projectId})`.execute(database);
  const repositoryId = `repo-${projectId.slice(0, 8)}`;
  repositories.set(`${projectId}:${repositoryId}`, { id: repositoryId, url: "https://github.com/Acme/Widget", requiredChecks });
  const taskId = crypto.randomUUID();
  await database.insertInto("task").values({ id: taskId, project_id: projectId, story_id: null, title: "Task", description: null,
    status: TaskStatus.TODO, assignee: null, reject_reason: null, resume_source_status: null, sort_order: 1, created_at: now, updated_at: now, task_key: null }).execute();
  grant(projectId, "worker-a", WorkRole.WORKER);
  grant(projectId, "reviewer-a", WorkRole.REVIEWER);
  grant(projectId, "manager-a", WorkRole.MANAGER);
  const claim = await service.claimTask("worker-a", taskId, `claim-${taskId}`);
  return { projectId, repositoryId, taskId, workClaimId: claim.claimId };
};
type Context = Awaited<ReturnType<typeof setup>>;

let sequence = 0;
const rid = (label: string) => `${label}-${(sequence += 1)}`;

const register = (context: Context, number: number, claimId = context.workClaimId) =>
  service.registerTaskPullRequest("worker-a", { taskId: context.taskId, claimId, repositoryId: context.repositoryId, number }, rid("register"));

const complete = async (context: Context, claimId = context.workClaimId) => {
  await service.addTaskComment("worker-a", context.taskId, claimId, "実装と検証", rid("comment"));
  return service.completeTask("worker-a", context.taskId, claimId, rid("complete"));
};

const claimReview = async (context: Context) => (await service.claimReview("reviewer-a", context.taskId, rid("claim-review"))).claimId;

/** PR #7を登録して完了した`in_review`の状態。 */
const completed = async (requiredChecks: string[] = []) => {
  const context = await setup(requiredChecks);
  github.put(7, { headSha: sha("b") });
  await register(context, 7);
  await complete(context);
  return context;
};

/** 完了したTaskのReview Claimを取得した状態。 */
const inReview = async (requiredChecks: string[] = []) => {
  const context = await completed(requiredChecks);
  return { ...context, reviewClaimId: await claimReview(context) };
};

/** Reviewerの手順: レビュー根拠のコメント → GitHubでmerge（`mergeHead`で別headのmergeも再現する）。 */
const approveAndMerge = (context: Context & { reviewClaimId: string }, reviewedHead = sha("b"), mergeHead = reviewedHead) => {
  const commentId = github.comment(7, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: reviewedHead, decision: "approve" });
  github.put(7, { state: "merged", headSha: mergeHead, mergeSha: sha("f") });
  return commentId;
};

const status = async (taskId: string) =>
  (await database.selectFrom("task").select("status").where("id", "=", taskId).executeTakeFirstOrThrow()).status;

const changePayload = async (taskId: string, type: string) => {
  const row = await database.selectFrom("change_log").select("payload").where("entity_id", "=", taskId).where("type", "=", type)
    .orderBy("cursor", "desc").executeTakeFirstOrThrow();
  return JSON.parse(row.payload) as Record<string, unknown>;
};

test("PR運用のTaskはWork完了→レビュー→merge→受入で、レビューしたheadとmerge SHAを照合して記録する", async () => {
  const context = await inReview();
  assert.equal((await changePayload(context.taskId, "TASK_COMPLETED")).pullRequest !== undefined, true);
  const commentId = approveAndMerge(context);
  const reviewed = await service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"),
    { expectedHeadSha: sha("b").toUpperCase(), reviewCommentId: commentId });
  assert.equal(reviewed.status, TaskStatus.WAIT_ACCEPT);

  const acceptance = await service.claimAcceptance("manager-a", context.taskId, rid("claim-acceptance"));
  const accepted = await service.acceptTask("manager-a", context.taskId, acceptance.claimId, rid("accept"), undefined,
    { mergeSha: sha("f"), evidence: "AC1: mergeコミットでテストを確認" });
  assert.equal(accepted.status, TaskStatus.ACCEPTED);

  const [pr] = (await service.listTaskPullRequests("manager-a", context.taskId)).pullRequests;
  assert.deepEqual(
    { state: pr!.state, reviewedHeadSha: pr!.reviewedHeadSha, reviewCommentId: pr!.reviewCommentId, acceptedMergeSha: pr!.acceptedMergeSha,
      acceptanceEvidence: pr!.acceptanceEvidence },
    { state: "merged", reviewedHeadSha: sha("b"), reviewCommentId: commentId, acceptedMergeSha: sha("f"), acceptanceEvidence: "AC1: mergeコミットでテストを確認" },
  );
  assert.deepEqual((await changePayload(context.taskId, "TASK_REVIEWED")).pullRequest,
    { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7", state: "merged", headSha: sha("b"), baseBranch: "main",
      mergeSha: sha("f"), requiredChecks: [], reviewCommentUrl: `https://github.com/acme/widget/pull/7#issuecomment-${commentId}` });
  const acceptedChange = await changePayload(context.taskId, "TASK_ACCEPTED");
  assert.equal((acceptedChange.pullRequest as { mergeSha: string }).mergeSha, sha("f"));
  assert.deepEqual(acceptedChange.verification, { mergeSha: sha("f"), evidence: "AC1: mergeコミットでテストを確認" });
});

test("未merge（merge失敗・競合）・mergeされずclose・レビュー後の新しいheadはレビュー成功にせず、照合の事実と再確認方法を返す", async () => {
  const context = await inReview();
  const commentId = github.comment(7, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: sha("b"), decision: "approve" });
  const input = { expectedHeadSha: sha("b"), reviewCommentId: commentId };

  // 競合でmergeできずopenのまま。
  const unmerged = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), input));
  assert.equal(unmerged.code, "PULL_REQUEST_NOT_READY");
  assert.match(unmerged.message, /^reviewed_task: .*not merged.*Task .*acme\/widget#7/);
  assert.deepEqual({ ...unmerged.details, recheck: undefined }, {
    operation: "reviewed_task", taskId: context.taskId, pullRequest: { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7" },
    expectedHeadSha: sha("b"), headSha: sha("b"), state: "open", mergeSha: null, recheck: undefined,
  });
  assert.match(String(unmerged.details!.recheck), /競合/);

  // レビュー後にWorkerが別のcommitをpushした。
  github.put(7, { headSha: sha("c") });
  const newHead = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), input));
  assert.deepEqual([newHead.code, newHead.details!.expectedHeadSha, newHead.details!.headSha], ["PULL_REQUEST_NOT_READY", sha("b"), sha("c")]);
  // 新しいheadのままmergeされた。
  github.put(7, { state: "merged", mergeSha: sha("f") });
  const mergedNewHead = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), input));
  assert.deepEqual([mergedNewHead.details!.state, mergedNewHead.details!.headSha], ["merged", sha("c")]);

  github.put(7, { state: "closed", headSha: sha("b"), mergeSha: null });
  const closed = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), input));
  assert.equal(closed.details!.state, "closed");

  assert.equal(await status(context.taskId), TaskStatus.IN_REVIEW, "照合に失敗したレビューは状態を変えない");
  assert.equal((await service.listTaskPullRequests("reviewer-a", context.taskId)).pullRequests[0]!.reviewedHeadSha, null);
  // Reviewerは差し戻せる（同じopen PRの修正へ）。
  await service.rejectTask("reviewer-a", context.taskId, context.reviewClaimId, "競合を解消して再提出", rid("reject"));
  assert.equal(await status(context.taskId), TaskStatus.REJECTED);
});

test("レビュー根拠は現在のReview Claim・レビューしたhead・approveの印を持つコメントだけで、GitHubのApproveは要らない", async () => {
  const context = await inReview();
  const reviewed = (reviewCommentId: number) =>
    service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), { expectedHeadSha: sha("b"), reviewCommentId });
  const otherClaim = github.comment(7, { taskId: context.taskId, claimId: crypto.randomUUID(), headSha: sha("b"), decision: "approve" });
  const oldHead = github.comment(7, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: sha("9"), decision: "approve" });
  const rejected = github.comment(7, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: sha("b"), decision: "reject" });
  const otherTask = github.comment(7, { taskId: crypto.randomUUID(), claimId: context.reviewClaimId, headSha: sha("b"), decision: "approve" });
  github.put(7, { state: "merged", mergeSha: sha("f") });
  for (const commentId of [otherClaim, oldHead, rejected, otherTask, 999_999]) {
    const error = await errorOf(reviewed(commentId));
    assert.equal(error.code, "PULL_REQUEST_NOT_READY");
    assert.deepEqual(error.details!.expectedMarker, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: sha("b"), decision: "approve" });
  }
  const missing = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed")));
  assert.equal(missing.code, "INVALID_INPUT");

  // PRの作成者と同じGitHubアカウント（agent-bot）のコメントで成立する。
  const approval = github.comment(7, { taskId: context.taskId, claimId: context.reviewClaimId, headSha: sha("b"), decision: "approve" });
  assert.equal((await reviewed(approval)).status, TaskStatus.WAIT_ACCEPT);
});

test("requiredChecks未設定ならCIを読まず必須にしない。指定したcheckだけが成功を必要とする", async () => {
  const free = await inReview([]);
  github.checks.set(sha("b"), [{ name: "lint", state: "failure" }]);
  const commentId = approveAndMerge(free);
  await service.reviewedTask("reviewer-a", free.taskId, free.reviewClaimId, rid("reviewed"), { expectedHeadSha: sha("b"), reviewCommentId: commentId });
  assert.equal(github.reads.checks, 0, "必須checkが無ければCI結果を読まない");

  // 同じGitHub PRは1つのTaskにだけ属するため、別のTaskの検証は新しいDBで行う。
  await database.deleteFrom("task_pull_request").execute();
  github = new FakeGitHub();
  service = createService();
  github.checks.set(sha("b"), []);
  const strict = await inReview(["test"]);
  const strictComment = approveAndMerge(strict);
  const reviewed = () => service.reviewedTask("reviewer-a", strict.taskId, strict.reviewClaimId, rid("reviewed"),
    { expectedHeadSha: sha("b"), reviewCommentId: strictComment });
  const absent = await errorOf(reviewed());
  assert.deepEqual(absent.details!.unsatisfiedChecks, [{ name: "test", states: [] }]);
  github.checks.set(sha("b"), [{ name: "test", state: "pending" }, { name: "lint", state: "failure" }]);
  const pending = await errorOf(reviewed());
  assert.deepEqual([pending.details!.requiredChecks, pending.details!.unsatisfiedChecks], [["test"], [{ name: "test", states: ["pending"] }]]);
  // 指定外のcheck（lint）の失敗は条件にしない。
  github.checks.set(sha("b"), [{ name: "test", state: "success" }, { name: "lint", state: "failure" }]);
  assert.equal((await reviewed()).status, TaskStatus.WAIT_ACCEPT);
});

test("受入はレビュー済みheadのmerge SHAとManagerの照合値・根拠が一致する場合だけ。Reviewerを経ない受入は拒否する", async () => {
  const done = await completed();
  // in_reviewのPR TaskはManager・Human operatorとも直接受入へ進めない。
  const direct = await errorOf(service.claimAcceptance("manager-a", done.taskId, rid("claim-acceptance")));
  assert.equal(direct.code, "PULL_REQUEST_NOT_READY");
  const operatorDirect = await errorOf(service.acceptTaskAsOperator("human-a", done.projectId, done.taskId));
  assert.deepEqual([operatorDirect.code, operatorDirect.details!.operation], ["PULL_REQUEST_NOT_READY", "operator_accept"]);
  assert.equal(await status(done.taskId), TaskStatus.IN_REVIEW);
  const context = { ...done, reviewClaimId: await claimReview(done) };

  const commentId = approveAndMerge(context);
  await service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), { expectedHeadSha: sha("b"), reviewCommentId: commentId });
  const { claimId } = await service.claimAcceptance("manager-a", context.taskId, rid("claim-acceptance"));
  const accept = (verification?: { mergeSha: string; evidence: string }) =>
    service.acceptTask("manager-a", context.taskId, claimId, rid("accept"), undefined, verification);
  assert.equal((await errorOf(accept())).code, "INVALID_INPUT");
  const wrong = await errorOf(accept({ mergeSha: sha("e"), evidence: "確認" }));
  assert.deepEqual([wrong.code, wrong.details!.expectedMergeSha, wrong.details!.mergeSha], ["PULL_REQUEST_NOT_READY", sha("e"), sha("f")]);
  await assert.rejects(accept({ mergeSha: sha("f"), evidence: "  " }), (error: unknown) => (error as CoordinationError).code === "INVALID_INPUT");
  assert.equal(await status(context.taskId), TaskStatus.WAIT_ACCEPT);
  assert.equal((await accept({ mergeSha: sha("f"), evidence: "AC確認" })).status, TaskStatus.ACCEPTED);
});

test("Human operatorの受入はレビュー済みのmergeを確認して受け入れ、merge SHAを記録する", async () => {
  const context = await inReview();
  const commentId = approveAndMerge(context);
  await service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), { expectedHeadSha: sha("b"), reviewCommentId: commentId });
  github.failure = new CoordinationError("GITHUB_UNAVAILABLE", "timeout");
  const unavailable = await errorOf(service.acceptTaskAsOperator("human-a", context.projectId, context.taskId));
  assert.deepEqual([unavailable.code, unavailable.details!.operation], ["GITHUB_UNAVAILABLE", "operator_accept"]);
  github.failure = null;
  assert.equal((await service.acceptTaskAsOperator("human-a", context.projectId, context.taskId)).status, TaskStatus.ACCEPTED);
  assert.equal((await service.listTaskPullRequests("manager-a", context.taskId)).pullRequests[0]!.acceptedMergeSha, sha("f"));
});

test("完了は現在のWork Claimで登録したopen・非draftのPRが必要。差し戻し後は同じPRを再登録して最新headを照合する", async () => {
  const context = await inReview();
  await service.rejectTask("reviewer-a", context.taskId, context.reviewClaimId, "テスト不足", rid("reject"));
  const { claimId } = await service.claimTask("worker-a", context.taskId, rid("reclaim"));
  github.put(7, { headSha: sha("c") });
  const stale = await errorOf(complete(context, claimId));
  assert.deepEqual([stale.code, stale.details!.registeredWorkClaimId, stale.details!.workClaimId], ["PULL_REQUEST_NOT_READY", context.workClaimId, claimId]);

  await register(context, 7, claimId);
  github.put(7, { draft: true });
  assert.equal((await errorOf(complete(context, claimId))).details!.draft, true);
  github.put(7, { draft: false, headSha: sha("d") });
  await complete(context, claimId);
  const [pr] = (await service.listTaskPullRequests("worker-a", context.taskId)).pullRequests;
  assert.deepEqual([pr!.headSha, pr!.reviewedHeadSha], [sha("d"), null], "完了時に現在のheadを記録する");
});

test("PRのbase branchが登録時から変わったら照合しない", async () => {
  const context = await inReview();
  const commentId = approveAndMerge(context);
  github.put(7, { baseBranch: "release" });
  const error = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"),
    { expectedHeadSha: sha("b"), reviewCommentId: commentId }));
  assert.deepEqual([error.details!.registeredBaseBranch, error.details!.baseBranch], ["main", "release"]);
});

test("GitHubを読めない失敗は操作・Task・PR・最後に確認した事実・再確認方法を返し何も記録しない。同じrequestIdで再送できる", async () => {
  const context = await inReview();
  const commentId = approveAndMerge(context);
  const input = { expectedHeadSha: sha("b"), reviewCommentId: commentId };
  github.failure = new CoordinationError("GITHUB_UNAVAILABLE", "GitHub returned HTTP 502");
  const unavailable = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, "reviewed-fixed", input));
  assert.equal(unavailable.retryable, true);
  assert.match(unavailable.message, /^reviewed_task: could not verify acme\/widget#7 of Task .* \(GitHub returned HTTP 502\); nothing was recorded$/);
  assert.deepEqual(unavailable.toJSON().details, {
    operation: "reviewed_task", taskId: context.taskId,
    pullRequest: { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7" },
    lastVerified: { state: "open", headSha: sha("b"), mergeSha: null, verifiedAt: 1_000 },
    github: { code: "GITHUB_UNAVAILABLE", message: "GitHub returned HTTP 502" },
    recheck: unavailable.details!.recheck,
  });
  assert.match(String(unavailable.details!.recheck), /同じ入力・同じrequestId/);
  github.failure = new CoordinationError("GITHUB_ACCESS_DENIED", "GitHub denied access (HTTP 403)");
  const denied = await errorOf(service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, rid("reviewed"), input));
  assert.deepEqual([denied.retryable, denied.code], [false, "GITHUB_ACCESS_DENIED"]);
  assert.equal(await status(context.taskId), TaskStatus.IN_REVIEW);

  github.failure = null;
  const first = await service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, "reviewed-fixed", input);
  // 応答が失われた後の再送は、GitHubを読まずに記録済みの結果を返す。
  const reads = { ...github.reads };
  github.failure = new CoordinationError("GITHUB_UNAVAILABLE", "down");
  assert.deepEqual(await service.reviewedTask("reviewer-a", context.taskId, context.reviewClaimId, "reviewed-fixed", input), first);
  assert.deepEqual(github.reads, reads);
});

test("GitHubを読む前にRole Grantを検査する", async () => {
  const context = await inReview();
  github.reads = { pulls: 0, comments: 0, checks: 0 };
  await assert.rejects(service.reviewedTask("outsider", context.taskId, context.reviewClaimId, rid("reviewed"), { expectedHeadSha: sha("b"), reviewCommentId: 1 }),
    (error: unknown) => (error as CoordinationError).code === "FORBIDDEN");
  assert.deepEqual(github.reads, { pulls: 0, comments: 0, checks: 0 });
});

test("PRを登録していないTaskは従来の経路（GitHubを読まない・Manager直接受入可）のまま。verificationは受け付けない", async () => {
  const context = await setup();
  await complete(context);
  const { claimId } = await service.claimAcceptance("manager-a", context.taskId, rid("claim-acceptance"));
  await assert.rejects(service.acceptTask("manager-a", context.taskId, claimId, rid("accept"), undefined, { mergeSha: sha("f"), evidence: "x" }),
    (error: unknown) => (error as CoordinationError).code === "INVALID_INPUT");
  assert.equal((await service.acceptTask("manager-a", context.taskId, claimId, rid("accept"))).status, TaskStatus.ACCEPTED);

  const reviewedPath = await setup();
  await complete(reviewedPath);
  const reviewClaimId = await claimReview(reviewedPath);
  assert.equal((await service.reviewedTask("reviewer-a", reviewedPath.taskId, reviewClaimId, rid("reviewed"))).status, TaskStatus.WAIT_ACCEPT);
  assert.deepEqual(github.reads, { pulls: 0, comments: 0, checks: 0 });
});

test("必須checkは同じ名前のcheck run・statusがすべて成功したときだけ満たす", () => {
  assert.deepEqual(unsatisfiedRequiredChecks([{ name: "a", state: "failure" }], []), []);
  assert.deepEqual(unsatisfiedRequiredChecks([{ name: "a", state: "success" }, { name: "a", state: "failure" }], ["a"]),
    [{ name: "a", states: ["success", "failure"] }]);
  assert.deepEqual(unsatisfiedRequiredChecks([{ name: "a", state: "success" }, { name: "b", state: "success" }], ["a", "b"]), []);
});

// GitHub REST API互換のloopback server。コメントの印・check run / commit statusの解釈をadapterごと確認する。
let respond: (path: string) => { status: number; body?: unknown } = () => ({ status: 500 });
const fakeApi: Server = createServer((request, response) => {
  const answer = respond(request.url ?? "");
  response.writeHead(answer.status, { "content-type": "application/json" });
  response.end(answer.body === undefined ? "" : JSON.stringify(answer.body));
});
await new Promise<void>((resolve) => fakeApi.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => fakeApi.close(() => resolve())));
const apiBaseUrl = `http://127.0.0.1:${(fakeApi.address() as AddressInfo).port}`;

test("GitHub adapterはレビュー根拠の印を持つコメントだけを返し、全pageを読む", async () => {
  const marker = formatReviewMarker({ taskId: "task-1", claimId: "claim-1", headSha: sha("b"), decision: "approve" });
  const filler = Array.from({ length: 100 }, (_, index) => ({ id: index + 1, html_url: `u${index}`, body: "LGTM", user: { login: "agent-bot" } }));
  respond = (path) => {
    if (!path.startsWith("/repos/acme/widget/issues/7/comments")) return { status: 404 };
    if (/[?&]page=1$/.test(path)) return { status: 200, body: filler };
    return { status: 200, body: [
      { id: 501, html_url: "https://github.com/acme/widget/pull/7#issuecomment-501", body: `レビュー結果\n\n${marker}`, user: { login: "agent-bot" } },
      { id: 502, html_url: "x", body: "<!-- compass-task-review: {broken} -->", user: { login: "agent-bot" } },
      { id: 503, html_url: "y", body: null, user: { login: "agent-bot" } },
    ] };
  };
  const gateway = new GitHubPullRequestGateway({ apiBaseUrl });
  assert.deepEqual(await gateway.listReviewEvidence({ owner: "acme", name: "widget" }, 7), [{
    commentId: 501, url: "https://github.com/acme/widget/pull/7#issuecomment-501", author: "agent-bot",
    taskId: "task-1", claimId: "claim-1", headSha: sha("b"), decision: "approve",
  }]);
  respond = () => ({ status: 200, body: { not: "a list" } });
  await assert.rejects(gateway.listReviewEvidence({ owner: "acme", name: "widget" }, 7),
    (error: unknown) => (error as CoordinationError).code === "GITHUB_UNAVAILABLE");
});

test("GitHub adapterはcheck run（完了ならconclusion）とcontextごとに最新のcommit statusを返す", async () => {
  respond = (path) => {
    if (path.startsWith(`/repos/acme/widget/commits/${sha("b")}/check-runs`)) {
      return { status: 200, body: { total_count: 2, check_runs: [
        { name: "test", status: "completed", conclusion: "success" },
        { name: "build", status: "in_progress", conclusion: null },
      ] } };
    }
    if (path.startsWith(`/repos/acme/widget/commits/${sha("b")}/statuses`)) {
      return { status: 200, body: [{ context: "ci/legacy", state: "failure" }, { context: "ci/legacy", state: "success" }] };
    }
    return { status: 404 };
  };
  const gateway = new GitHubPullRequestGateway({ apiBaseUrl });
  assert.deepEqual(await gateway.listChecks({ owner: "acme", name: "widget" }, sha("b")), [
    { name: "test", state: "success" }, { name: "build", state: "pending" }, { name: "ci/legacy", state: "failure" },
  ]);
});
