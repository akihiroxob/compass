import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Miniflare } from "miniflare";
import type { D1Database } from "@cloudflare/workers-types";
import { initializeD1TestSchema } from "../../server/tests/support/d1Runtime.ts";
import { createOidcFixture } from "../../server/tests/support/oidcFixture.ts";

/** 配布用bundle自体をworkerdで実行する。外部OIDCだけを署名付きfixtureで置換する。 */
test("Workers bundle serves UI, Google OIDC, Human APIs and Agent Credential MCP on native D1", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  execFileSync("npm", ["run", "worker:build"], { cwd: root, env: { ...process.env, WRANGLER_SEND_METRICS: "false", COMPASS_DEPLOY_REVISION: "a".repeat(40) }, stdio: "pipe" });
  const origin = "https://compass.example.test";
  const settings = { clientId: "fixture-client", clientSecret: "fixture-secret", redirectUri: `${origin}/auth/google/callback`,
    endpoints: { authorization: "https://accounts.google.com/o/oauth2/v2/auth", token: "https://oauth2.googleapis.com/token", jwks: "https://www.googleapis.com/oauth2/v3/certs" } };
  const outgoing: string[] = [];
  const fixture = createOidcFixture({ now: Date.now() }, settings);
  const runtime = new Miniflare({ workers: [{ config: {
    name: "compass-workers-test", compatibilityDate: "2026-11-10",
    manifest: { mainModule: "worker.js", modulesRoot: root, modules: {
      "worker.js": { type: "esm", contents: await readFile(new URL("../../server/.generated/bundle/worker.js", import.meta.url), "utf8") },
    } },
    env: { DB: { type: "d1", id: "workers-runtime" }, ASSETS: { type: "assets" },
      COMPASS_PUBLIC_ORIGIN: { type: "json", value: origin }, COMPASS_GOOGLE_CLIENT_ID: { type: "json", value: settings.clientId },
      COMPASS_GOOGLE_CLIENT_SECRET: { type: "json", value: settings.clientSecret }, COMPASS_INITIAL_OWNER_EMAIL: { type: "json", value: "owner@example.test" } },
    assets: { directory: `${root}server/public`, runWorkerFirst: true, hasUserWorker: true, htmlHandling: "none" },
  }, dev: { outboundService: { type: "node-handler", handler: async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const url = new URL(request.url!, `https://${request.headers.host}`).href;
    outgoing.push(url);
    if (url.startsWith("https://api.github.com/repos/example/product/commits/")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ sha: new URL(url).pathname.split("/").at(-1) }));
      return;
    }
    if (url.startsWith("https://api.github.com/repos/example/product/pulls/1")) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ number: 1, html_url: "https://github.com/example/product/pull/1", state: "open", draft: false, merged: false,
        merge_commit_sha: null, user: { login: "agent" }, head: { ref: "task", sha: "b".repeat(40) }, base: { ref: "main", repo: { full_name: "example/product" } } }));
      return;
    }
    const result = await fixture.fetch(url, { method: request.method, body: Buffer.concat(chunks).toString() });
    response.writeHead(result.status, Object.fromEntries(result.headers.entries()));
    response.end(await result.text());
  } } } }] });
  try {
    const binding = await runtime.getD1Database("DB") as unknown as D1Database;
    // 起動側にschema作成を任せない。未適用DBでは503で、tableを作らない。
    const unprepared = await runtime.dispatchFetch(`${origin}/health`);
    assert.equal(unprepared.status, 503, await unprepared.text());
    assert.equal(await binding.prepare("SELECT name FROM sqlite_master WHERE name = 'workspace'").first(), null);
    await initializeD1TestSchema(binding);
    const request = (path: string, init?: Parameters<typeof runtime.dispatchFetch>[1]) => runtime.dispatchFetch(`${origin}${path}`, { redirect: "manual", ...init });
    assert.equal((await request("/health")).status, 200);
    const html = await request("/workspaces");
    assert.equal(html.status, 200);
    assert.match(await html.text(), /<div id="root">/);
    assert.equal((await request("/api/workspaces")).status, 401);
    assert.equal((await request("/api/no-such-route")).status, 404);
    const start = await request("/auth/google/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" }, body: "returnTo=%2Fworkspaces" });
    assert.equal(start.status, 302, await start.clone().text());
    const authorization = new URL(start.headers.get("location")!);
    assert.equal(authorization.origin, "https://accounts.google.com");
    const loginCookie = start.headers.get("set-cookie")!.split(";")[0]!;
    fixture.codes.set("fixture-code", { claims: fixture.claims("owner", "owner@example.test", authorization.searchParams.get("nonce")!), challenge: authorization.searchParams.get("code_challenge")! });
    const callback = await request(`/auth/google/callback?code=fixture-code&state=${authorization.searchParams.get("state")}`, { headers: { Cookie: loginCookie } });
    assert.equal(callback.status, 302, await callback.clone().text());
    assert.equal(callback.headers.get("location"), "/workspaces", JSON.stringify({ outgoing, token: fixture.tokenRequests, jwks: fixture.jwksFetches, attempt: await binding.prepare("SELECT consumed_at IS NOT NULL AS consumed FROM auth_login_attempt").all() }));
    const cookie = callback.headers.getSetCookie().find((value) => value.startsWith("__Host-compass_session="))?.split(";")[0];
    assert.ok(cookie, callback.headers.get("set-cookie")!);
    const session = await request("/api/auth/session", { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json() as { csrfToken: string };
    const human = (path: string, body: object) => request(path, { method: "POST", headers: { Cookie: cookie, Origin: origin, "X-Compass-CSRF": csrfToken, "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const created = await human("/api/workspaces", { name: "Business", mission: "Goal" });
    assert.equal(created.status, 201, await created.clone().text());
    const { workspace } = await created.json() as { workspace: { id: string } };
    const projectResponse = await human(`/api/workspaces/${workspace.id}/projects`, { name: "Product", repositories: [{ name: "Source", url: "https://github.com/example/product" }] });
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const { project } = await projectResponse.json() as { project: { id: string; repositories: { id: string }[] } };
    assert.equal((await human(`/api/projects/${project.id}/grants`, { role: "worker", principalId: "worker" })).status, 201);
    const issued = await human(`/api/projects/${project.id}/credentials`, { kind: "agent", principalId: "worker" });
    assert.equal(issued.status, 201, await issued.clone().text());
    const { token } = await issued.json() as { token: string };
    const taskResponse = await human(`/api/projects/${project.id}/tasks`, { title: "Worker task" });
    assert.equal(taskResponse.status, 201, await taskResponse.clone().text());
    const { task } = await taskResponse.json() as { task: { id: string } };
    const mcp = async (name: string, args: object) => {
      const response = await request("/mcp", { method: "POST", headers: { Authorization: `Bearer ${token}`, "X-Compass-Active-Role": "worker", Accept: "application/json, text/event-stream", "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) });
      assert.equal(response.status, 200, await response.clone().text());
      const body = await response.text();
      const data = body.split("\n").find((line) => line.startsWith("data: "));
      assert.ok(data, body);
      const result = JSON.parse(data.slice(6)) as { result: { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] } };
      assert.equal(result.result.isError, undefined, data);
      return result.result;
    };
    const claim = await mcp("claim_task", { taskId: task.id, requestId: "worker-claim" });
    await mcp("register_task_pull_request", { taskId: task.id, claimId: claim.structuredContent.claimId, repositoryId: project.repositories[0]!.id, number: 1, requestId: "worker-pr" });
    assert.ok(outgoing.some((url) => url.startsWith("https://api.github.com/")));
    const assets = await mcp("get_role_context", { projectId: project.id, role: "worker" });
    assert.match(JSON.stringify(assets), /worker/);
    const runtimeCredentialResponse = await human(`/api/projects/${project.id}/credentials`, { kind: "runtime", principalId: "deployer", scopes: ["publication:write"] });
    assert.equal(runtimeCredentialResponse.status, 201);
    const runtimeCredential = await runtimeCredentialResponse.json() as { token: string };
    const publicationInput = { repositoryId: project.repositories[0]!.id, revision: "c".repeat(40), target: "production", observedAt: Date.now() - 1000,
      evidence: [{ kind: "deployment", uri: "https://deploy.example.test/run/1" }] };
    const publish = () => request(`/api/projects/${project.id}/publications`, { method: "POST", headers: { Authorization: `Bearer ${runtimeCredential.token}`, "Content-Type": "application/json" }, body: JSON.stringify(publicationInput) });
    const publication = await publish();
    assert.equal(publication.status, 201, await publication.clone().text());
    const replayed = await publish();
    assert.equal(replayed.status, 200, await replayed.clone().text());
    assert.equal((await binding.prepare("SELECT count(*) AS count FROM publication_record").first<{ count: number }>())?.count, 1);
    assert.equal(fixture.tokenRequests, 1);
    assert.equal(fixture.jwksFetches, 1);
    assert.equal((await binding.prepare("SELECT status FROM task WHERE id = ?").bind(task.id).first<{ status: string }>())?.status, "doing");
  } finally { await runtime.dispose(); }
});
