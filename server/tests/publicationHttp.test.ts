import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { after } from "node:test";
import { formatReviewMarker, GitHubPullRequestGateway } from "@compass/work";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { createTestHuman, requestAs } from "./support/humanSession.ts";

/**
 * 開発受入と公開確認を別の根拠として記録・取得する（UI-P1）。Taskの準備はG2と同じ公開MCP（Worker / Reviewer / Managerの別Principal）で
 * 受入済み・未mergeを作り、公開確認は専用のProject Runtime Credential（`publication:write`）が公開API・MCPで送る。Humanはリリース履歴を
 * Web APIで読む。GitHubはREST API互換のloopback server（PR・コメント・commit・compare）で、Serverは本番と同じadapterで読む。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };
type Json = Record<string, any>;

const sha = (digit: string) => digit.repeat(40);
/** main branchの線形の履歴（先祖→子孫）。PRのmerge commitもここへ積む。 */
const history: string[] = [sha("1")];
const pulls = new Map<number, { state: "open" | "closed"; merged: boolean; headSha: string; mergeSha: string | null }>();
const comments = new Map<number, { id: number; html_url: string; body: string; user: { login: string } }[]>();
let outage: number | null = null;

const json = (response: import("node:http").ServerResponse, status: number, body: unknown) =>
  response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
const api = createServer((request, response) => {
  if (outage !== null) return void response.writeHead(outage).end();
  const url = new URL(request.url ?? "", "http://localhost");
  let match = /^\/repos\/acme\/widget\/pulls\/(\d+)$/.exec(url.pathname);
  if (match) {
    const pull = pulls.get(Number(match[1]));
    if (!pull) return json(response, 404, { message: "Not Found" });
    return json(response, 200, {
      number: Number(match[1]), html_url: `https://github.com/acme/widget/pull/${match[1]}`, state: pull.state, draft: false, merged: pull.merged,
      merge_commit_sha: pull.mergeSha, user: { login: "agent-bot" }, head: { ref: "task", sha: pull.headSha },
      base: { ref: "main", repo: { full_name: "acme/widget" } },
    });
  }
  match = /^\/repos\/acme\/widget\/issues\/(\d+)\/comments$/.exec(url.pathname);
  if (match) return json(response, 200, url.searchParams.get("page") === "1" ? comments.get(Number(match[1])) ?? [] : []);
  match = /^\/repos\/acme\/widget\/commits\/([a-f0-9]{40})$/.exec(url.pathname);
  if (match) return history.includes(match[1]!) ? json(response, 200, { sha: match[1] }) : json(response, 422, { message: "No commit found" });
  match = /^\/repos\/acme\/widget\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(url.pathname);
  if (match) {
    const [base, head] = [history.indexOf(match[1]!), history.indexOf(match[2]!)];
    if (base < 0 || head < 0) return json(response, 404, { message: "Not Found" });
    return json(response, 200, { status: base === head ? "identical" : base < head ? "ahead" : "behind" });
  }
  return json(response, 404, { message: "Not Found" });
});
await new Promise<void>((resolve) => api.listen(0, "127.0.0.1", resolve));
after(() => new Promise<void>((resolve) => api.close(() => resolve())));
const apiBaseUrl = `http://127.0.0.1:${(api.address() as AddressInfo).port}`;

let rpcId = 0;
const mcp = async (app: App, method: string, params: object, headers: Record<string, string>) => {
  const response = await app.request("/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
  });
  assert.equal(response.status, 200);
  const data = (await response.text()).split("\n").find((line) => line.startsWith("data: "));
  assert.ok(data);
  return JSON.parse(data.slice(6)).result;
};
const callTool = (app: App, name: string, args: object, principal: string, activeRole: string): Promise<ToolResult> =>
  mcp(app, "tools/call", { name, arguments: args }, { Authorization: `Bearer ${principal}`, "X-Compass-Active-Role": activeRole });
const ok = (result: ToolResult) => {
  assert.equal(result.isError, undefined, JSON.stringify(result.structuredContent));
  return result.structuredContent;
};
const send = (method: string, body: unknown): RequestInit => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let commentId = 100;
/** Manager起票→Worker（PR登録・完了）→Reviewer（根拠コメント・merge照合）→Manager（merge SHAで受入）。`stopAt`でその手前に止める。 */
const runTask = async (app: App, projectId: string, repositoryId: string, number: number, label: string, stopAt: "in_review" | "accepted") => {
  const task = ok(await callTool(app, "issue_task", { projectId, title: label, requestId: `${label}-issue` }, "manager-a", "manager"));
  const work = ok(await callTool(app, "claim_task", { taskId: task.id, requestId: `${label}-claim` }, "worker-a", "worker"));
  const headSha = sha(String.fromCharCode(97 + number));
  pulls.set(number, { state: "open", merged: false, headSha, mergeSha: null });
  ok(await callTool(app, "register_task_pull_request", { taskId: task.id, claimId: work.claimId, repositoryId, number, requestId: `${label}-pr` }, "worker-a", "worker"));
  ok(await callTool(app, "add_task_comment", { taskId: task.id, claimId: work.claimId, body: "実装と検証", requestId: `${label}-note` }, "worker-a", "worker"));
  ok(await callTool(app, "complete_task", { taskId: task.id, claimId: work.claimId, requestId: `${label}-done` }, "worker-a", "worker"));
  if (stopAt === "in_review") return task.id as string;
  const review = ok(await callTool(app, "claim_review", { taskId: task.id, requestId: `${label}-review` }, "reviewer-a", "reviewer"));
  const id = (commentId += 1);
  comments.set(number, [{ id, html_url: `https://github.com/acme/widget/pull/${number}#issuecomment-${id}`, user: { login: "agent-bot" },
    body: formatReviewMarker({ taskId: task.id, claimId: review.claimId, headSha, decision: "approve" }) }]);
  const mergeSha = sha(String(number + 1));
  history.push(mergeSha);
  pulls.set(number, { state: "closed", merged: true, headSha, mergeSha });
  ok(await callTool(app, "reviewed_task", { taskId: task.id, claimId: review.claimId, expectedHeadSha: headSha, reviewCommentId: id, requestId: `${label}-reviewed` }, "reviewer-a", "reviewer"));
  const acceptance = ok(await callTool(app, "claim_acceptance", { taskId: task.id, requestId: `${label}-acceptance` }, "manager-a", "manager"));
  ok(await callTool(app, "accept_task", { taskId: task.id, claimId: acceptance.claimId, requestId: `${label}-accept`,
    verification: { mergeSha, evidence: "AC: mergeコミットで確認" } }, "manager-a", "manager"));
  return task.id as string;
};

test("Runtimeの公開確認を開発受入と別の記録として残し、Humanはリリース履歴で受入済み／公開済み／未公開／確認できずを区別して読める", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const github = new GitHubPullRequestGateway({ apiBaseUrl });
  const app = createApp(createApplicationServices(database, undefined, undefined, { initialOwnerEmail: null }, { pullRequests: github, revisions: github }));
  try {
    const owner = await createTestHuman(database);
    const asOwner = requestAs(app, owner);
    const { project } = await (await asOwner("/api/projects", send("POST", { name: "Release", mission: "公開を辿れる", repositories: [
      { name: "widget", url: "https://github.com/acme/widget" },
    ] }))).json() as { project: { id: string; repositories: { id: string }[] } };
    const repositoryId = project.repositories[0]!.id;
    for (const [principalId, role] of [["manager-a", "manager"], ["worker-a", "worker"], ["reviewer-a", "reviewer"]]) {
      assert.equal((await asOwner(`/api/projects/${project.id}/grants`, send("POST", { principalId, role }))).status, 201);
    }
    const first = await runTask(app, project.id, repositoryId, 1, "first", "accepted");
    const second = await runTask(app, project.id, repositoryId, 2, "second", "accepted");
    const pending = await runTask(app, project.id, repositoryId, 3, "pending", "in_review");
    const releases = async () => {
      const response = await asOwner(`/api/projects/${project.id}/releases`);
      assert.equal(response.status, 200);
      return (await response.json()) as Json;
    };
    const statusOf = (body: Json, taskId: string) => {
      const change = body.changes.find((candidate: Json) => candidate.task.id === taskId);
      return [change.development.status, change.publication.status, change.publication.reason];
    };

    // 公開確認の入力元がない: 受入済み・merge済みでも公開済みにせず「確認できず」。
    const unconfigured = await releases();
    assert.equal(unconfigured.publicationSource.configured, false);
    assert.deepEqual(statusOf(unconfigured, first), ["accepted", "unconfirmed", "not_configured"]);
    assert.deepEqual(statusOf(unconfigured, pending), ["not_accepted", "unconfirmed", "not_configured"]);

    // 専用のRuntime主体（publication:writeだけ）を発行すると、記録がなくても入力元ありとして「公開記録なし」で確認できず。
    const issue = async (principalId: string, scopes: string[]) => {
      const response = await asOwner(`/api/projects/${project.id}/credentials`, send("POST", { kind: "runtime", principalId, scopes }));
      assert.equal(response.status, 201);
      return ((await response.json()) as { token: string }).token;
    };
    const token = await issue("deployer", ["publication:write"]);
    const otherScope = await issue("summary-reader", ["execution:summary:read"]);
    assert.deepEqual(statusOf(await releases(), first), ["accepted", "unconfirmed", "no_record"]);

    const publish = (authorization: string | null, body: object) => app.request(`/api/projects/${project.id}/publications`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(authorization ? { Authorization: authorization } : {}) },
      body: JSON.stringify(body),
    });
    const deploy = (revision: string, observedAt: number, target = "production") => ({
      repositoryId, revision, target, targetUrl: "https://widget.example.test", method: "github-actions", observedAt,
      evidence: [{ kind: "deployment", uri: "https://github.com/acme/widget/actions/runs/1" }],
    });
    const now = Date.now();
    // 認可: Bearerなし・scope不足のCredential・Human SessionではRuntimeの記録を受け付けない。
    assert.equal((await publish(null, deploy(sha("2"), now - 5_000))).status, 401);
    assert.equal((await publish(`Bearer ${otherScope}`, deploy(sha("2"), now - 5_000))).status, 403);
    assert.equal((await asOwner(`/api/projects/${project.id}/publications`, send("POST", deploy(sha("2"), now - 5_000)))).status, 401);
    // Repositoryに無いrevisionは成果版として記録しない。GitHubを読めなければ503で何も記録しない。
    assert.equal((await publish(`Bearer ${token}`, deploy(sha("9"), now - 5_000))).status, 400);
    outage = 502;
    const unavailable = await publish(`Bearer ${token}`, deploy(sha("2"), now - 5_000));
    assert.deepEqual([unavailable.status, ((await unavailable.json()) as Json).error.retryable], [503, true]);
    outage = null;

    // 1件目のmerge（sha 2）だけを含むrevisionを公開: 1件目は公開済み、2件目は受入済みでも未公開。
    const recorded = await publish(`Bearer ${token}`, deploy(sha("2"), now - 5_000));
    assert.equal(recorded.status, 201);
    const publication = ((await recorded.json()) as Json).publication;
    assert.deepEqual([publication.includedCommits, publication.notIncludedCommits, publication.principalId], [[sha("2")], [sha("3")], "deployer"]);
    const resent = await publish(`Bearer ${token}`, deploy(sha("2"), now - 5_000));
    assert.deepEqual([resent.status, ((await resent.json()) as Json).recorded], [200, false]);
    const partial = await releases();
    assert.deepEqual(statusOf(partial, first), ["accepted", "published", null]);
    assert.deepEqual(statusOf(partial, second), ["accepted", "not_published", null]);
    assert.deepEqual(statusOf(partial, pending), ["not_accepted", "unconfirmed", "no_revision"], "未mergeは公開済みにも未公開にもしない");
    const traced = partial.changes.find((change: Json) => change.task.id === second);
    assert.deepEqual([traced.pullRequest.number, traced.pullRequest.acceptedMergeSha, traced.revisions[0].commitSha], [2, sha("3"), sha("3")]);

    // MCPでも同じ契約で記録できる（Runtime専用tool）。2件のmergeを含む新しいrevisionで、両Taskが公開済みになる。
    const listed = await mcp(app, "tools/list", {}, { Authorization: `Bearer ${token}` });
    const tool = listed.tools.find((candidate: Json) => candidate.name === "record_publication");
    assert.deepEqual([tool._meta["compass/context"], tool._meta["compass/caller"]], ["work", "runtime"]);
    const viaMcp = await mcp(app, "tools/call", { name: "record_publication", arguments: { projectId: project.id, ...deploy(sha("3"), now - 1_000) } },
      { Authorization: `Bearer ${token}` });
    assert.equal(viaMcp.isError, undefined, JSON.stringify(viaMcp.structuredContent));
    // 遅れて届いた古い通知（確認日時が前・古いrevision）は原記録に残し、現在の状況を戻さない。
    const stale = await publish(`Bearer ${token}`, deploy(sha("1"), now - 9_000));
    assert.equal(((await stale.json()) as Json).superseded, true);

    const all = await releases();
    assert.deepEqual(statusOf(all, first), ["accepted", "published", null]);
    assert.deepEqual(statusOf(all, second), ["accepted", "published", null]);
    assert.equal(all.publications.length, 3);
    assert.deepEqual(all.publications.map((record: Json) => [record.revision, record.current]),
      [[sha("3"), true], [sha("2"), false], [sha("1"), false]]);

    // viewerではないHuman（未所属）は読めない。
    const stranger = await createTestHuman(database, { email: "stranger@example.test" });
    assert.equal((await requestAs(app, stranger)(`/api/projects/${project.id}/releases`)).status, 404);
  } finally {
    await database.destroy();
  }
});
