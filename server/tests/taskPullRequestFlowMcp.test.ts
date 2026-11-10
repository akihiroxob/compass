import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { formatReviewMarker, GitHubPullRequestGateway } from "@compass/work";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { createTestHuman, requestAs } from "./support/humanSession.ts";

/**
 * PR運用のTaskを公開MCP（Worker / Reviewer / Manager の別Principal・activeRole）とWeb APIで Work完了→レビュー→merge→受入 へ進める。
 * GitHubはREST API互換のloopback server（PR・Issue comment・check run・commit status）で、Serverは本番と同じ`GitHubPullRequestGateway`で読む。
 * 全員が同じGitHubアカウント（`agent-bot`）でPR・コメントを書く。Repositoryの必須check（requiredChecks）はWeb APIで設定する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

const sha = (digit: string) => digit.repeat(40);
type Pull = { state: "open" | "closed"; merged: boolean; headSha: string; mergeSha: string | null };
const pulls = new Map<number, Pull>();
const comments = new Map<number, { id: number; html_url: string; body: string; user: { login: string } }[]>();
const checkRuns = new Map<string, { name: string; status: string; conclusion: string | null }[]>();
let outage: number | null = null;

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const api = createServer((request, response) => {
  if (outage !== null) return void response.writeHead(outage).end();
  const url = new URL(request.url ?? "", "http://localhost");
  let match = /^\/repos\/acme\/widget\/pulls\/(\d+)$/i.exec(url.pathname);
  if (match) {
    const pull = pulls.get(Number(match[1]));
    if (!pull) return json(response, 404, { message: "Not Found" });
    return json(response, 200, {
      number: Number(match[1]), html_url: `https://github.com/acme/widget/pull/${match[1]}`, state: pull.state, draft: false, merged: pull.merged,
      merge_commit_sha: pull.mergeSha, user: { login: "agent-bot" }, head: { ref: "task", sha: pull.headSha },
      base: { ref: "main", repo: { full_name: "acme/widget" } },
    });
  }
  match = /^\/repos\/acme\/widget\/issues\/(\d+)\/comments$/i.exec(url.pathname);
  if (match) return json(response, 200, url.searchParams.get("page") === "1" ? comments.get(Number(match[1])) ?? [] : []);
  match = /^\/repos\/acme\/widget\/commits\/([a-f0-9]{40})\/(check-runs|statuses)$/i.exec(url.pathname);
  if (match) {
    if (match[2] === "statuses") return json(response, 200, []);
    const runs = url.searchParams.get("page") === "1" ? checkRuns.get(match[1]!) ?? [] : [];
    return json(response, 200, { total_count: runs.length, check_runs: runs });
  }
  return json(response, 404, { message: "Not Found" });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => api.close(() => resolve())));
const apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

let commentId = 100;
/** Reviewerが（Workerと同じGitHubアカウントで）PRに残すレビュー根拠のコメント。 */
const postReviewComment = (number: number, marker: { taskId: string; claimId: string; headSha: string; decision: "approve" | "reject" }) => {
  const id = (commentId += 1);
  const list = comments.get(number) ?? [];
  list.push({ id, html_url: `https://github.com/acme/widget/pull/${number}#issuecomment-${id}`, body: `検証結果: OK\n\n${formatReviewMarker(marker)}`, user: { login: "agent-bot" } });
  comments.set(number, list);
  return id;
};

const open = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: null }, {
    pullRequests: new GitHubPullRequestGateway({ apiBaseUrl }),
  });
  return { database, app: createApp(services) };
};

let rpcId = 0;
const callTool = async (app: App, name: string, args: object, principal: string, activeRole: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${principal}`,
      "X-Compass-Active-Role": activeRole,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};
const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};
const failure = (result: ToolResult) => {
  assert.equal(result.isError, true, JSON.stringify(result.structuredContent));
  return result.structuredContent.error as { code: string; retryable: boolean; message: string; details?: Record<string, any> };
};
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const seed = async (app: App, asOwner: ReturnType<typeof requestAs>, name: string, requiredChecks?: string[]) => {
  const { project } = await (await asOwner("/api/projects", send("POST", { name, mission: "PR facts stay verified", repositories: [
    { name: "widget", url: "https://github.com/acme/widget", ...(requiredChecks ? { requiredChecks } : {}) },
  ] }))).json() as { project: { id: string; repositories: { id: string; name: string; url: string; requiredChecks: string[] }[] } };
  for (const [principalId, role] of [["manager-a", "manager"], ["worker-a", "worker"], ["reviewer-a", "reviewer"]]) {
    assert.equal((await asOwner(`/api/projects/${project.id}/grants`, send("POST", { principalId, role }))).status, 201);
  }
  return { projectId: project.id, repository: project.repositories[0]! };
};

/** ManagerがTaskを起票し、Workerが取得・PR登録・完了し、Reviewerが取得する。 */
const toReview = async (app: App, projectId: string, repositoryId: string, number: number, label: string) => {
  const task = ok(await callTool(app, "issue_task", { projectId, title: label, requestId: `${label}-issue` }, "manager-a", "manager"));
  const work = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: `${label}-claim` }, "worker-a", "worker"));
  pulls.set(number, { state: "open", merged: false, headSha: sha("b"), mergeSha: null });
  ok(await callTool(app, "register_task_pull_request", { taskId: task.id, claimId: work.claimId, repositoryId, number, requestId: `${label}-pr` }, "worker-a", "worker"));
  ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "実装と検証", requestId: `${label}-note` }, "worker-a", "worker"));
  const completed = ok(await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: `${label}-done` }, "worker-a", "worker"));
  assert.equal(completed.status, "in_review");
  return { taskId: task.id as string };
};

test("PR運用のTaskはMCPでレビューしたheadのmergeと受入のmerge SHAを照合し、失敗は操作・PR・SHA・状態・再確認方法を返す", async () => {
  const { database, app } = await open();
  try {
    pulls.clear();
    comments.clear();
    checkRuns.clear();
    outage = null;
    const owner = await createTestHuman(database);
    const asOwner = requestAs(app, owner);
    const { projectId, repository } = await seed(app, asOwner, "Alpha");
    assert.deepEqual(repository.requiredChecks, [], "requiredChecksの既定は空（CIを必須にしない）");
    const { taskId } = await toReview(app, projectId, repository.id, 7, "alpha");

    // Reviewerを経ない受入（ManagerのMCP・HumanのWeb API）はPRのあるTaskでは拒否する。
    assert.equal(failure(await callTool(app, "claim_acceptance", { taskId, requestId: "direct" }, "manager-a", "manager")).code, "PULL_REQUEST_NOT_READY");
    const operatorDirect = await asOwner(`/api/projects/${projectId}/tasks/${taskId}/accept`, { method: "POST" });
    assert.equal(operatorDirect.status, 409);
    assert.match(JSON.stringify(await operatorDirect.json()), /operator_accept: a Task with a pull request cannot skip reviewed_task/);

    const review = ok(await callTool(app, "claim_review", { taskId, requestId: "review" }, "reviewer-a", "reviewer"));
    const reviewed = (requestId: string, reviewCommentId: number, expectedHeadSha = sha("b")) =>
      callTool(app, "reviewed_task", { taskId, claimId: review.claimId, expectedHeadSha, reviewCommentId, requestId }, "reviewer-a", "reviewer");
    const approval = postReviewComment(7, { taskId, claimId: review.claimId, headSha: sha("b"), decision: "approve" });

    // mergeに失敗（競合）してopenのまま。
    const unmerged = failure(await reviewed("rv-1", approval));
    assert.equal(unmerged.code, "PULL_REQUEST_NOT_READY");
    assert.match(unmerged.message, /^reviewed_task: the pull request is open and not merged \(Task .*, acme\/widget#7\)$/);
    assert.deepEqual({ operation: unmerged.details!.operation, taskId: unmerged.details!.taskId, pullRequest: unmerged.details!.pullRequest,
      state: unmerged.details!.state, headSha: unmerged.details!.headSha },
    { operation: "reviewed_task", taskId, pullRequest: { repository: "acme/widget", number: 7, url: "https://github.com/acme/widget/pull/7" },
      state: "open", headSha: sha("b") });
    assert.equal(typeof unmerged.details!.recheck, "string");

    // レビュー後に新しいheadがpushされてmergeされた。
    pulls.set(7, { state: "closed", merged: true, headSha: sha("c"), mergeSha: sha("f") });
    const newHead = failure(await reviewed("rv-2", approval));
    assert.deepEqual([newHead.details!.expectedHeadSha, newHead.details!.headSha, newHead.details!.state], [sha("b"), sha("c"), "merged"]);

    // GitHubが読めない間は何も記録せず、同じrequestIdで再送できる。
    pulls.set(7, { state: "closed", merged: true, headSha: sha("b"), mergeSha: sha("f") });
    outage = 502;
    const unavailable = failure(await reviewed("rv-3", approval));
    assert.deepEqual([unavailable.code, unavailable.retryable, unavailable.details!.operation], ["GITHUB_UNAVAILABLE", true, "reviewed_task"]);
    assert.match(unavailable.message, /could not verify acme\/widget#7 .*HTTP 502.*nothing was recorded/);
    outage = null;
    assert.equal(ok(await reviewed("rv-3", approval)).status, "wait_accept", "必須checkの指定がなければCIを確認しない");

    const acceptance = ok(await callTool(app, "claim_acceptance", { taskId, requestId: "acceptance" }, "manager-a", "manager"));
    const accept = (requestId: string, verification?: object) =>
      callTool(app, "accept_task", { taskId, claimId: acceptance.claimId, requestId, ...(verification ? { verification } : {}) }, "manager-a", "manager");
    assert.equal(failure(await accept("ac-1")).code, "INVALID_INPUT");
    const mismatch = failure(await accept("ac-2", { mergeSha: sha("e"), evidence: "AC1: OK" }));
    assert.deepEqual([mismatch.code, mismatch.details!.expectedMergeSha, mismatch.details!.mergeSha], ["PULL_REQUEST_NOT_READY", sha("e"), sha("f")]);
    assert.equal(ok(await accept("ac-3", { mergeSha: sha("f"), evidence: "AC1: mergeコミットで確認" })).status, "accepted");

    const [pr] = ok(await callTool(app, "list_task_pull_requests", { taskId }, "worker-a", "worker")).pullRequests;
    assert.deepEqual([pr.reviewedHeadSha, pr.reviewCommentId, pr.acceptedMergeSha, pr.acceptanceEvidence],
      [sha("b"), approval, sha("f"), "AC1: mergeコミットで確認"]);
  } finally {
    await database.destroy();
  }
});

test("requiredChecksを指定したRepositoryは、そのcheckの成功だけを必要条件にし、Web UIの編集で値を失わない", async () => {
  const { database, app } = await open();
  try {
    pulls.clear();
    comments.clear();
    checkRuns.clear();
    outage = null;
    const owner = await createTestHuman(database);
    const asOwner = requestAs(app, owner);
    const { projectId, repository } = await seed(app, asOwner, "Beta", ["test"]);
    // Web UIの編集フォームと同じく、requiredChecksを送らずにRepositoryを保存しても値は維持される。
    const patched = await (await asOwner(`/api/projects/${projectId}`, send("PATCH", { repositories: [
      { id: repository.id, name: "widget-app", url: repository.url, kind: "" },
    ] }))).json() as { project: { repositories: { name: string; requiredChecks: string[] }[] } };
    assert.deepEqual(patched.project.repositories.map(({ name, requiredChecks }) => [name, requiredChecks]), [["widget-app", ["test"]]]);

    const { taskId } = await toReview(app, projectId, repository.id, 8, "beta");
    const review = ok(await callTool(app, "claim_review", { taskId, requestId: "review" }, "reviewer-a", "reviewer"));
    const approval = postReviewComment(8, { taskId, claimId: review.claimId, headSha: sha("b"), decision: "approve" });
    pulls.set(8, { state: "closed", merged: true, headSha: sha("b"), mergeSha: sha("f") });
    const reviewed = (requestId: string) =>
      callTool(app, "reviewed_task", { taskId, claimId: review.claimId, expectedHeadSha: sha("b"), reviewCommentId: approval, requestId }, "reviewer-a", "reviewer");

    checkRuns.set(sha("b"), [{ name: "test", status: "completed", conclusion: "failure" }, { name: "lint", status: "completed", conclusion: "success" }]);
    const failing = failure(await reviewed("rv-1"));
    assert.deepEqual([failing.details!.requiredChecks, failing.details!.unsatisfiedChecks], [["test"], [{ name: "test", states: ["failure"] }]]);
    checkRuns.set(sha("b"), [{ name: "test", status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "failure" }]);
    assert.equal(ok(await reviewed("rv-2")).status, "wait_accept", "指定外のcheck（lint）の失敗は条件にしない");
  } finally {
    await database.destroy();
  }
});

test("PRを登録していないTaskは従来どおりReviewerの承認とManagerの直接受入で進められる", async () => {
  const { database, app } = await open();
  try {
    const owner = await createTestHuman(database);
    const asOwner = requestAs(app, owner);
    const { projectId } = await seed(app, asOwner, "Gamma");
    const task = ok(await callTool(app, "issue_task", { projectId, title: "docs", requestId: "g-issue" }, "manager-a", "manager"));
    const work = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: "g-claim" }, "worker-a", "worker"));
    ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "記録", requestId: "g-note" }, "worker-a", "worker"));
    ok(await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: "g-done" }, "worker-a", "worker"));
    const acceptance = ok(await callTool(app, "claim_acceptance", { taskId: task.id, requestId: "g-acceptance" }, "manager-a", "manager"));
    assert.equal(ok(await callTool(app, "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: "g-accept" }, "manager-a", "manager")).status, "accepted");
  } finally {
    await database.destroy();
  }
});
