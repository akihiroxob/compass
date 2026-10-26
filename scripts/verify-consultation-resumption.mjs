#!/usr/bin/env node
/** Bounded real-Agent verification, pinned to cwd HEAD and isolated from development data. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = await realpath(process.cwd());
const script = fileURLToPath(import.meta.url);
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const directory = await mkdtemp(join(tmpdir(), 'compass-consultation-real-'));
const data = join(directory, 'data');
await mkdir(data);
const requireTarget = createRequire(join(root, 'package.json'));
const imported = async (name) => import(pathToFileURL(join(root, name)).href);
const evidence = { schemaVersion: 1, headSha, sourceRoot: root, directory,
  preparationScriptSha256: createHash('sha256').update(await readFile(script)).digest('hex'),
  realAgents: true, startedAt: new Date().toISOString(), steps: [] };
const children = new Set();
const ownedPids = new Set();
let server, database, interrupted = false;
const stopDispatches = async () => {
  try {
    const dispatches = JSON.parse(await readFile(join(directory, 'dispatch/dispatches.json'), 'utf8'));
    for (const record of Object.values(dispatches.records)) {
      if (record.status === 'running' && ownedPids.has(record.ownerPid) && record.childPid) {
        try { process.kill(-record.childPid, 'SIGTERM'); } catch {}
      }
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  interrupted = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  stopDispatches().catch((error) => { evidence.cleanupError = error.message; });
});
const save = async () => writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const run = async (label, command, args, options = {}) => {
  if (interrupted) throw new Error('Verification interrupted');
  const log = await open(join(directory, label + '.log'), 'a', 0o600);
  const process = spawn(command, args, { cwd: root, env: { ...globalThis.process.env, ...options.env },
    stdio: ['ignore', log.fd, log.fd], detached: true, ...options });
  children.add(process);
  ownedPids.add(process.pid);
  const exit = new Promise((resolve, reject) => {
    process.once('error', reject);
    process.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(async () => { children.delete(process); await log.close(); });
  let forceKillTimer;
  const timer = setTimeout(() => {
    try { globalThis.process.kill(-process.pid, 'SIGTERM'); } catch {}
    forceKillTimer = setTimeout(() => { try { globalThis.process.kill(-process.pid, 'SIGKILL'); } catch {} }, 5_000);
    forceKillTimer.unref();
  }, 240_000);
  try { const result = await exit; assert.equal(result.code, 0, `${label} failed; see ${directory}/${label}.log`); }
  finally { clearTimeout(timer); clearTimeout(forceKillTimer); }
};
try {
  await run('prepare', process.execPath, ['--import', 'tsx', join(dirname(script), 'prepare-browser-verification.mjs'), '--data-dir', data], {
    env: { ...process.env, COMPASS_DB_PATH: join(data, 'preview.db'), COMPASS_AUTH_MODE: 'trusted-local',
      COMPASS_INITIAL_OWNER_EMAIL: 'preview-owner@example.test' },
  });
  const manifest = JSON.parse(await readFile(join(data, 'browser-fixtures.json'), 'utf8'));
  assert.equal(manifest.headSha, headSha);
  assert.equal(manifest.dataPreparation.consultationResumptionEnabled, true, 'Inspected SHA has no complete resumption contract');
  const projectId = manifest.dataPreparation.projectIds[0];
  const actors = manifest.dataPreparation.actors;
  const { createDatabase } = await imported('server/src/bootstrap/database/createDatabase.ts');
  const { createApplicationServices } = await imported('server/src/bootstrap/createApplicationServices.ts');
  const { createApp } = await imported('server/src/bootstrap/app.ts');
  const { serve } = await import(pathToFileURL(requireTarget.resolve('@hono/node-server')).href);
  database = createDatabase(join(data, 'preview.db'));
  const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: 'preview-owner@example.test' });
  let origin;
  const app = createApp(services, { humanAuth: { mode: 'trusted-local', publicOrigin: 'http://127.0.0.1' } });
  // publicOrigin must match CSRF requests; re-create the app after the OS allocates a loopback port.
  let fetchHandler = app.fetch;
  server = serve({ fetch: (...args) => fetchHandler(...args), hostname: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  fetchHandler = createApp(services, { humanAuth: { mode: 'trusted-local', publicOrigin: origin } }).fetch;
  const mcp = async (role, name, args) => {
    assert.ok(manifest.dataPreparation.allowedTools.includes(name), `Preview policy does not permit ${name}`);
    const response = await fetch(origin + '/mcp', { method: 'POST', headers: {
      'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${actors[role]}`, 'X-Compass-Active-Role': role,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {
      name, arguments: { ...args, requestId: crypto.randomUUID() },
    } }) });
    assert.equal(response.status, 200);
    const raw = await response.text();
    const result = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw).result;
    assert.ok(!result.isError, JSON.stringify(result.structuredContent));
    return result.structuredContent;
  };
  const login = await fetch(origin + '/auth/local/login', { method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ email: 'preview-owner@example.test' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').match(/compass_session=[^;]+/)[0];
  const session = await (await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie } })).json();
  const humanPost = async (path, body) => {
    const response = await fetch(origin + path, { method: 'POST', headers: { Cookie: cookie, Origin: origin,
      'X-Compass-CSRF': session.csrfToken, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.ok(response.ok, `Human API ${path}: ${response.status}`);
    return response.json();
  };
  const issued = await humanPost(`/api/projects/${projectId}/credentials`, {
    kind: 'runtime', principalId: 'preview-consultation-runtime', scopes: ['runtime:state:read'],
  });
  const runtimeToken = issued.token;
  assert.equal(typeof runtimeToken, 'string');
  const artifacts = join(directory, 'artifacts');
  execFileSync('git', ['clone', '--shared', '--no-checkout', root, artifacts], { stdio: 'ignore' });
  execFileSync('git', ['checkout', '--detach', headSha], { cwd: artifacts, stdio: 'ignore' });
  await mkdir(join(artifacts, '.compass-ralph'), { recursive: true });
  const contextPath = join(artifacts, '.compass-ralph/previous-context.json');
  await writeFile(contextPath, JSON.stringify({ reason: 'Human selection is pending', headSha }));
  await writeFile(join(artifacts, 'evidence.txt'), 'Preserve this uncommitted verification artifact.\n');
  const preserved = await readFile(join(artifacts, 'evidence.txt'));
  const task = await mcp('manager', 'issue_task', { projectId, title: '[検証専用] Humanの色の選択を記録',
    description: '既存evidence.txtとContextを保持し、相談の結論からresumed.txtへ色を記録する。commit/push/Acceptは行わず、検証コメントとcomplete_taskでin_reviewまで進める。' });
  const work = await mcp('worker', 'claim_task', { taskId: task.id });
  const consultation = await mcp('worker', 'create_consultation', { projectId, title: '検証用の色の選択',
    question: '検証成果物にはblueとredのどちらを記録しますか', blockingReason: 'Humanの選択が必要',
    recommendation: 'blue', impact: 'この専用検証Taskのresumed.txtのみ', options: [{ label: 'blue' }, { label: 'red' }], refs: [{ kind: 'task', id: task.id }] });
  const consultationId = consultation.consultation?.id ?? consultation.id;
  const metadata = join(directory, 'runtime.json');
  await writeFile(metadata, JSON.stringify({ worktreePath: artifacts, contextPath, pullRequest: null, verificationRefs: [] }));
  const runtime = JSON.parse(execFileSync(process.execPath, [join(root, 'ralph/runtime/consultation-context.mjs'), metadata], { encoding: 'utf8' }));
  await mcp('worker', 'wait_for_consultation', { taskId: task.id, claimId: work.claimId, consultationIds: [consultationId], reason: 'Humanの選択待ち', runtime });
  evidence.steps.push({ phase: 'waiting_human', taskId: task.id, consultationId, claimId: work.claimId, runtime });
  const reply = await humanPost(`/api/projects/${projectId}/consultations/${consultationId}/messages`, { body: 'blueを選びます。この検証成果物にblueを記録してください。', requestId: crypto.randomUUID() });
  evidence.steps.push({ phase: 'human_replied', consultationId, replyRevision: reply.consultation?.revision });
  await save();
  const managerScript = join(directory, 'manager.mjs');
  const managerInstruction = '専用検証Projectの指定された相談だけを処理する。指定以外のMCP・Wacha・Repositoryを操作しない。Humanの色の選択が明確ならcurrent revisionのleaseを取得し、そのHuman messageを根拠に結論を保存する。TaskのAcceptはしない。';
  await writeFile(managerScript, `import {spawn} from 'node:child_process';\nconst p=spawn('codex',['exec','--skip-git-repo-check','--ephemeral','--color','never','--sandbox','workspace-write','-c',${JSON.stringify(`mcp_servers.compass.url=${JSON.stringify(origin + '/mcp')}`)},'-c','mcp_servers.compass.bearer_token_env_var="VERIFY_MANAGER"','-c','mcp_servers.compass.http_headers={"X-Compass-Active-Role"="manager"}','-c','mcp_servers.compass.default_tools_approval_mode="approve"','-c','mcp_servers.wacha.enabled=false','-'],{cwd:${JSON.stringify(directory)},env:process.env,stdio:['pipe','inherit','inherit']});p.stdin.end(process.env.COMPASS_PROMPT+'\\n'+${JSON.stringify(managerInstruction)});p.on('exit',code=>process.exit(code??1));\n`);
  const orchestratorConfig = join(directory, 'orchestrator.json');
  await writeFile(orchestratorConfig, JSON.stringify({ serverUrl: origin, stateDir: join(directory, 'dispatch'), leaseMs: 180_000, maxAttempts: 1,
    consultationProjects: [{ projectId, tokenEnv: 'VERIFY_RUNTIME', agentEnv: { VERIFY_MANAGER: actors.manager } }],
    roles: { manager: { command: `${JSON.stringify(process.execPath)} ${JSON.stringify(managerScript)}` } } }));
  await run('manager', process.execPath, ['--import', 'tsx', join(root, 'orchestrator/src/main.ts'), '--config', orchestratorConfig, '--once'],
    { env: { ...process.env, VERIFY_RUNTIME: runtimeToken } });
  const resolved = await mcp('manager', 'get_consultation', { projectId, consultationId });
  assert.equal(resolved.consultation.status, 'resolved', 'Real Manager did not resolve the Human input');
  evidence.steps.push({ phase: 'real_manager_resolved', revision: resolved.consultation.revision });
  const workerPrompt = join(directory, 'worker.md');
  await writeFile(workerPrompt, 'Compassのworkerとして専用検証Taskだけを再開する。末尾の取得済みContextを使用しClaimし直さない。Role Contextと再開Skill・保存Context・全相談の結論・現在Taskを確認する。結論の色をresumed.txtへ1行で保存しevidence.txtを保持する。Task Commentとcomplete_taskでin_reviewまで進める。commit/push/Accept・他Task・Wacha操作は禁止。');
  const ralphConfig = join(directory, 'ralph.json');
  await writeFile(ralphConfig, JSON.stringify({ serverUrl: origin, projectId, projectRoot: artifacts, agentProvider: 'codex',
    roles: { worker: { tokenEnv: 'VERIFY_WORKER', prompt: workerPrompt } } }));
  await run('worker', 'bash', [join(root, 'ralph/bin/ralph'), 'run', 'worker', '--config', ralphConfig, '--once'],
    { env: { ...process.env, VERIFY_WORKER: actors.worker } });
  const after = await mcp('worker', 'list_tasks', { projectId });
  const current = after.tasks.find((item) => item.id === task.id);
  assert.ok(current, 'Verification Task is missing');
  assert.equal(current.status, 'in_review');
  assert.equal((await readFile(join(artifacts, 'resumed.txt'), 'utf8')).trim(), 'blue');
  assert.deepEqual(await readFile(join(artifacts, 'evidence.txt')), preserved);
  assert.deepEqual(await readFile(contextPath), Buffer.from(JSON.stringify({ reason: 'Human selection is pending', headSha })));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: artifacts, encoding: 'utf8' }).trim(), headSha);
  const notes = await mcp('worker', 'list_task_comments', { taskId: task.id });
  const resumedNote = notes.comments.find((item) => item.principalId === actors.worker && item.claimId !== work.claimId);
  assert.ok(resumedNote, 'No verification note from the resumed Claim');
  evidence.resumedClaimId = resumedNote.claimId;
  evidence.steps.push({ phase: 'real_worker_resumed', taskId: task.id, state: current.status, artifactsPreserved: true });
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = error.message; process.exitCode = 1;
} finally {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  // Orchestrator launches separate process groups; stop only this run's unfinished dispatches.
  try { await stopDispatches(); }
  catch (error) { evidence.cleanupError = error.message; evidence.result = 'failed'; process.exitCode = 1; }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (database) await database.destroy();
  evidence.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ result: evidence.result, headSha, evidencePath: join(directory, 'evidence.json'), error: evidence.error }));
}
