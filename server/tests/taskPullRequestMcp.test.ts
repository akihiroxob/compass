import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { GitHubPullRequestGateway } from "@compass/work";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { createTestHuman, requestAs } from "./support/humanSession.ts";

/**
 * TaskへのPR登録・一覧を公開MCPで確認する。GitHubはGitHub REST API互換のloopback server（制御可能なadapter）で、
 * Serverは本番と同じ`GitHubPullRequestGateway`でHTTP越しに読む。2 Project・Web APIで登録したRepository・Work Claimを使い、
 * 登録・履歴・requestIdの再送、別Project / Repository・不正URL・古いClaim・権限不足の拒否、GitHub障害と確定失敗の区別を見る。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; content: { text: string }[]; structuredContent: Record<string, any> };

type Pull = { state: "open" | "closed"; draft?: boolean; merged?: boolean; headSha: string; repo?: string };
const pulls = new Map<string, Pull>();
let outage: number | null = null;
let observedAuthorization: (string | undefined)[] = [];
const api = createServer((request, response) => {
  observedAuthorization.push(request.headers.authorization);
  const match = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/(\d+)$/.exec(request.url ?? "");
  if (outage !== null) {
    response.writeHead(outage).end();
    return;
  }
  const key = match ? `${match[1]}/${match[2]}#${match[3]}`.toLowerCase() : "";
  const pull = pulls.get(key);
  if (!match || !pull) {
    response.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ message: "Not Found" }));
    return;
  }
  const [owner, name, number] = [match[1]!, match[2]!, Number(match[3])];
  response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({
    number, html_url: `https://github.com/${owner}/${name}/pull/${number}`, state: pull.state, draft: pull.draft ?? false,
    merged: pull.merged ?? false, merge_commit_sha: pull.merged ? "f".repeat(40) : null, user: { login: "agent-bot" },
    head: { ref: `task-${number}`, sha: pull.headSha }, base: { ref: "main", repo: { full_name: pull.repo ?? `${owner}/${name}` } },
  }));
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => api.close(() => resolve())));
const apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

const open = async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: null }, {
    pullRequests: new GitHubPullRequestGateway({ apiBaseUrl, token: "fixture-token" }),
  });
  return { database, app: createApp(services) };
};

let rpcId = 0;
const callTool = async (app: App, name: string, args: object, principal: string, activeRole?: string): Promise<ToolResult> => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${principal}`,
      ...(activeRole === undefined ? {} : { "X-Compass-Active-Role": activeRole }),
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
  return result.structuredContent.error as { code: string; retryable: boolean; message: string };
};
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

/** ownerがWeb APIでRepository付きのProjectを作り、Worker / Reviewerを付与する。ManagerがTaskを起票し、Workerが取得する。 */
const seedProject = async (app: App, asOwner: ReturnType<typeof requestAs>, name: string, repositoryUrl: string) => {
  const created = await (await asOwner("/api/projects", post({ name, mission: "PR facts stay verified", repositories: [
    { name: "app", url: repositoryUrl }, { name: "mirror", url: "https://git.example.com/acme/widget.git" },
  ] }))).json() as { project: { id: string; repositories: { id: string; name: string }[] } };
  const { project } = created;
  for (const [principalId, role] of [["manager-a", "manager"], ["worker-a", "worker"], ["reviewer-a", "reviewer"]]) {
    assert.equal((await asOwner(`/api/projects/${project.id}/grants`, post({ principalId, role }))).status, 201);
  }
  const task = ok(await callTool(app, "issue_task", { projectId: project.id, title: `${name} Task`, requestId: `${name}-task` }, "manager-a", "manager"));
  const claim = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: `${name}-claim` }, "worker-a", "worker"));
  const [repository, local] = project.repositories;
  return { projectId: project.id, taskId: task.id as string, claimId: claim.claimId as string, repositoryId: repository!.id, localRepositoryId: local!.id };
};

test("Workerは現在のWork ClaimでopenなPRを登録し、Task別の履歴を読める。同じrequestIdの再送・GitHub障害・拒否を区別する", async () => {
  const { database, app } = await open();
  try {
    pulls.clear();
    outage = null;
    observedAuthorization = [];
    pulls.set("acme/widget#7", { state: "open", headSha: "a".repeat(40) });
    pulls.set("acme/widget#8", { state: "open", draft: true, headSha: "b".repeat(40) });
    pulls.set("acme/widget#9", { state: "closed", merged: true, headSha: "c".repeat(40) });
    pulls.set("acme/gadget#3", { state: "open", headSha: "d".repeat(40) });
    const owner = await createTestHuman(database);
    const asOwner = requestAs(app, owner);
    const a = await seedProject(app, asOwner, "Alpha", "https://github.com/Acme/Widget");
    const b = await seedProject(app, asOwner, "Beta", "https://github.com/acme/gadget.git");
    const register = (target: typeof a, number: number, requestId: string, extra: object = {}, principal = "worker-a", role = "worker") =>
      callTool(app, "register_task_pull_request", { taskId: target.taskId, claimId: target.claimId, repositoryId: target.repositoryId, number, requestId, ...extra }, principal, role);

    // 通信断で応答が失われた可能性がある間に、GitHubが一時的に読めない。何も記録されず、retryableで返る。
    outage = 503;
    const unavailable = failure(await register(a, 7, "reg-1"));
    assert.deepEqual([unavailable.code, unavailable.retryable], ["GITHUB_UNAVAILABLE", true]);
    assert.deepEqual(ok(await callTool(app, "list_task_pull_requests", { taskId: a.taskId }, "worker-a", "worker")).pullRequests, []);
    outage = null;

    // 復旧後に同じ入力・requestIdで再送すると登録される。
    const registered = ok(await register(a, 7, "reg-1")).pullRequest;
    assert.equal(registered.number, 7);
    assert.equal(registered.url, "https://github.com/Acme/Widget/pull/7");
    assert.equal(registered.repository, "acme/widget");
    assert.equal(registered.headSha, "a".repeat(40));
    assert.equal(registered.baseBranch, "main");
    assert.equal(registered.state, "open");
    assert.equal(registered.mergeSha, null);
    assert.equal(registered.workClaimId, a.claimId);
    assert.equal(typeof registered.verifiedAt, "number");

    // 登録済みの応答が失われた場合も、同じrequestIdの再送はGitHubを読まずに同じ結果を返し、重複しない。
    outage = 503;
    assert.deepEqual(ok(await register(a, 7, "reg-1")).pullRequest, registered);
    outage = null;
    const history = ok(await callTool(app, "list_task_pull_requests", { taskId: a.taskId }, "reviewer-a", "reviewer"));
    assert.deepEqual(history.pullRequests.map((pr: any) => [pr.number, pr.current]), [[7, true]]);
    assert.equal(failure(await register(a, 8, "reg-1")).code, "IDEMPOTENCY_CONFLICT");

    // 確定失敗: draft・merged・存在しないPR、GitHubが別base Repositoryを返したPR。
    assert.equal(failure(await register(a, 8, "reg-2")).code, "PULL_REQUEST_NOT_READY");
    assert.equal(failure(await register(a, 9, "reg-3")).code, "PULL_REQUEST_NOT_READY");
    const missing = failure(await register(a, 404, "reg-4"));
    assert.deepEqual([missing.code, missing.retryable], ["PULL_REQUEST_NOT_FOUND", false]);
    pulls.set("acme/widget#10", { state: "open", headSha: "e".repeat(40), repo: "someone/widget" });
    assert.equal(failure(await register(a, 10, "reg-5")).code, "PULL_REQUEST_NOT_READY");

    // 別ProjectのRepository・GitHub以外のURLのRepositoryは拒否する。
    assert.equal(failure(await register(a, 3, "reg-6", { repositoryId: b.repositoryId })).code, "INVALID_INPUT");
    assert.equal(failure(await register(a, 7, "reg-7", { repositoryId: a.localRepositoryId })).code, "INVALID_INPUT");
    // 別ProjectのTaskは自分のRepositoryのPRを登録でき、Task別の履歴は混ざらない（同じPRの別Taskへの登録拒否はWorkの単体テスト）。
    assert.equal(ok(await register(b, 3, "reg-8")).pullRequest.repository, "acme/gadget");
    assert.deepEqual(ok(await callTool(app, "list_task_pull_requests", { taskId: b.taskId }, "worker-a", "worker")).pullRequests.map((pr: any) => pr.number), [3]);

    // 他TaskのClaim・権限不足（reviewer）・Grantのない主体の一覧。
    assert.equal(failure(await register(a, 7, "reg-10", { claimId: b.claimId })).code, "CLAIM_NOT_FOUND");
    assert.equal(failure(await register(a, 7, "reg-11", {}, "reviewer-a", "reviewer")).code, "CLAIM_NOT_OWNED");
    // Claimの所有者でも、操作ContextのactiveRoleがworkerでなければ権限不足（Grantを合算しない）。
    assert.equal((await asOwner(`/api/projects/${a.projectId}/grants`, post({ principalId: "worker-a", role: "reviewer" }))).status, 201);
    assert.equal(failure(await register(a, 7, "reg-11", {}, "worker-a", "reviewer")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(app, "list_task_pull_requests", { taskId: a.taskId }, "outsider")).code, "FORBIDDEN");

    // 古いClaim（解放後）は拒否する。
    ok(await callTool(app, "release_claim", { claimId: a.claimId, reason: "handoff", requestId: "release-a" }, "worker-a", "worker"));
    assert.equal(failure(await register(a, 7, "reg-12")).code, "CLAIM_EXPIRED");

    // 一覧の事実は登録時のまま。tokenは結果・本文へ出ない。
    const final = await callTool(app, "list_task_pull_requests", { taskId: a.taskId }, "manager-a", "manager");
    assert.deepEqual(ok(final).pullRequests.map((pr: any) => pr.number), [7]);
    assert.ok(!JSON.stringify(final).includes("fixture-token"));
    assert.ok(observedAuthorization.every((value) => value === "Bearer fixture-token"));

    // 確認の履歴はTaskのChange Logに残る（canonical Activityには投影しない）。
    const changes = ok(await callTool(app, "list_changes", { projectId: a.projectId }, "worker-a", "worker")).changes as { type: string; entityId: string }[];
    assert.equal(changes.filter((change) => change.type === "TASK_PULL_REQUEST_REGISTERED" && change.entityId === a.taskId).length, 1);
  } finally {
    await database.destroy();
  }
});
