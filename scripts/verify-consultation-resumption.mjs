#!/usr/bin/env node
/**
 * Bounded real-Agent verification, pinned to cwd HEAD and isolated from development data.
 * In a dedicated DB and a Project created by the Owner through the public Web API, real Agents run the Story's paths:
 * Project Consultation → real Manager (after an Orchestrator crash/restart) → real Worker resumption (after a Ralph Runner
 * crash/restart and Claim expiry), Workspace Consultation → real Strategist, and the conclusion → document follow-up →
 * real Worker commit → real Reviewer → real Manager acceptance with deliverables → artifact reference, then a Server restart
 * on the same DB. Stand-in Agents are used only to hold a Runner's dispatch while the Runner is killed; they never write.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { chmod, mkdtemp, mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPreviewMcpClient } from './preview-operation-policy.mjs';

const root = await realpath(process.cwd());
const script = fileURLToPath(import.meta.url);
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const directory = await mkdtemp(join(tmpdir(), 'compass-consultation-real-'));
const data = join(directory, 'data');
await mkdir(data);
// Real-time Claim expiry after a Runner crash; long enough for one real Agent turn.
const claimTtlMs = 120_000;
process.env.COMPASS_CLAIM_TTL_MS = String(claimTtlMs);
const requireTarget = createRequire(join(root, 'package.json'));
const imported = async (name) => import(pathToFileURL(join(root, name)).href);
const evidence = { schemaVersion: 2, headSha, sourceRoot: root, directory,
  preparationScriptSha256: createHash('sha256').update(await readFile(script)).digest('hex'),
  realAgents: true, claimTtlMs, startedAt: new Date().toISOString(), steps: [] };
const step = (phase, fields = {}) => { evidence.steps.push({ phase, at: new Date().toISOString(), ...fields }); };
const children = new Set();
const ownedPids = new Set();
const dispatchDirectories = [join(directory, 'dispatch'), join(directory, 'dispatch-workspace')];
let server, database, interrupted = false;
const stopDispatches = async () => {
  for (const dispatchDirectory of dispatchDirectories) {
    try {
      const dispatches = JSON.parse(await readFile(join(dispatchDirectory, 'dispatches.json'), 'utf8'));
      for (const record of Object.values(dispatches.records)) {
        if (record.status === 'running' && ownedPids.has(record.ownerPid) && record.childPid) {
          try { process.kill(-record.childPid, 'SIGTERM'); } catch {}
        }
      }
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
};
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  interrupted = true;
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  stopDispatches().catch((error) => { evidence.cleanupError = error.message; });
});
const save = async () => writeFile(join(directory, 'evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitFor = async (label, check, timeoutMs = 60_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(250);
  }
};
/** Starts a process group whose output goes to `<label>.log`; `exit` resolves with its code/signal. */
const start = async (label, command, args, options = {}) => {
  if (interrupted) throw new Error('Verification interrupted');
  const log = await open(join(directory, label + '.log'), 'a', 0o600);
  const child = spawn(command, args, { cwd: root, env: { ...process.env, ...options.env },
    stdio: ['ignore', log.fd, log.fd], detached: true });
  children.add(child);
  ownedPids.add(child.pid);
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal }));
  }).finally(async () => { children.delete(child); await log.close(); });
  return { child, exit };
};
const run = async (label, command, args, options = {}) => {
  const { child, exit } = await start(label, command, args, options);
  let forceKillTimer;
  const timer = setTimeout(() => {
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    forceKillTimer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 5_000);
    forceKillTimer.unref();
  }, options.timeoutMs ?? 300_000);
  try {
    const result = await exit;
    assert.equal(result.code, options.expectCode ?? 0, `${label} exited ${result.code ?? result.signal}; see ${directory}/${label}.log`);
    return result;
  } finally { clearTimeout(timer); clearTimeout(forceKillTimer); }
};
const readJson = async (path) => JSON.parse(await readFile(path, 'utf8'));
try {
  await run('prepare', process.execPath, ['--import', 'tsx', join(dirname(script), 'prepare-browser-verification.mjs'), '--data-dir', data], {
    env: { COMPASS_DB_PATH: join(data, 'preview.db'), COMPASS_AUTH_MODE: 'trusted-local', COMPASS_INITIAL_OWNER_EMAIL: 'preview-owner@example.test' },
  });
  const manifest = await readJson(join(data, 'browser-fixtures.json'));
  assert.equal(manifest.headSha, headSha);
  assert.equal(manifest.dataPreparation.consultationResumptionEnabled, true, 'Inspected SHA has no complete resumption contract');
  const actors = manifest.dataPreparation.actors;
  const { createDatabase } = await imported('server/src/bootstrap/database/createDatabase.ts');
  const { createApplicationServices } = await imported('server/src/bootstrap/createApplicationServices.ts');
  const { createApp } = await imported('server/src/bootstrap/app.ts');
  const { serve } = await import(pathToFileURL(requireTarget.resolve('@hono/node-server')).href);
  // The Server process stays; `startServer` replaces the services on the same DB file to restart the application.
  let fetchHandler = () => new Response('starting', { status: 503 });
  server = serve({ fetch: (...args) => fetchHandler(...args), hostname: '127.0.0.1', port: 0 });
  await new Promise((resolve) => server.listening ? resolve() : server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const startServer = () => {
    database = createDatabase(join(data, 'preview.db'));
    const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: 'preview-owner@example.test' });
    // publicOrigin must match CSRF requests of the OS-allocated loopback port.
    fetchHandler = createApp(services, { humanAuth: { mode: 'trusted-local', publicOrigin: origin } }).fetch;
  };
  startServer();
  const login = await fetch(origin + '/auth/local/login', { method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ email: 'preview-owner@example.test' }) });
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie').match(/compass_session=[^;]+/)[0];
  const session = await (await fetch(origin + '/api/auth/session', { headers: { Cookie: cookie } })).json();
  const human = async (method, path, body) => {
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie, Origin: origin,
      'X-Compass-CSRF': session.csrfToken, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `Human API ${method} ${path}: ${response.status}`);
    return response.json();
  };
  // A dedicated Project in the prepared Workspace, created and granted by the Owner through the public Web API, so that no
  // prepared Task or Consultation is a candidate of the real Runners.
  const { workspaceId } = manifest.scenarios.find(({ projects }) => projects.some(({ id }) => id === manifest.dataPreparation.projectIds[0]));
  assert.ok(manifest.dataPreparation.workspaceIds.includes(workspaceId));
  const { project } = await human('POST', `/api/workspaces/${workspaceId}/projects`, { name: '[実Agent検証] 相談の統合運転' });
  const projectId = project.id;
  for (const role of ['manager', 'worker', 'reviewer']) await human('POST', `/api/projects/${projectId}/grants`, { principalId: actors[role], role });
  const repository = (await human('PATCH', `/api/projects/${projectId}`, {
    repositories: [{ name: 'verification-docs', url: 'https://example.test/verification-docs.git' }] })).project.repositories[0];
  // The verification scope adds only this run's Project; the scope-based policy and the Server's Grants still apply.
  const preparation = { ...manifest.dataPreparation, projectIds: [...manifest.dataPreparation.projectIds, projectId] };
  const client = createPreviewMcpClient({ origin, preparation });
  client.observe({ projectId }, repository);
  const mcp = (role, name, args) => client.call(role, name, args);
  const projectToken = (await human('POST', `/api/projects/${projectId}/credentials`, {
    kind: 'runtime', principalId: 'preview-consultation-runtime', scopes: ['runtime:state:read'] })).token;
  const workspaceToken = (await human('POST', `/api/workspaces/${workspaceId}/credentials`, {
    kind: 'runtime', principalId: 'preview-workspace-runtime', scopes: ['runtime:state:read'] })).token;
  assert.equal(typeof projectToken, 'string');
  assert.equal(typeof workspaceToken, 'string');
  step('dedicated_project', { workspaceId, projectId, repositoryId: repository.id });

  // Agent commands. Real Agents use the dedicated Compass MCP only (the development Wacha MCP is disabled).
  const codexArgs = (role, tokenEnv, sandbox = 'workspace-write') => ['exec', '--skip-git-repo-check', '--ephemeral', '--color', 'never',
    ...(sandbox === 'bypass' ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--sandbox', sandbox]),
    '-c', `mcp_servers.compass.url=${JSON.stringify(origin + '/mcp')}`, '-c', `mcp_servers.compass.bearer_token_env_var="${tokenEnv}"`,
    '-c', `mcp_servers.compass.http_headers={"X-Compass-Active-Role"="${role}"}`,
    '-c', 'mcp_servers.compass.default_tools_approval_mode="approve"', '-c', 'mcp_servers.wacha.enabled=false', '-'];
  /** Orchestrator Role command running a real Agent for `targets` only; other dispatches of the prepared Workspace are left alone. */
  const realRole = async (name, { role, tokenEnv, targets, instruction }) => {
    const path = join(directory, name + '.mjs');
    await writeFile(path, `import {spawn} from 'node:child_process';\nif (!${JSON.stringify(targets)}.includes(process.env.COMPASS_SUBJECT_ID)) process.exit(0);\n` +
      `const p=spawn('codex',${JSON.stringify(codexArgs(role, tokenEnv))},{cwd:${JSON.stringify(directory)},env:process.env,stdio:['pipe','inherit','inherit']});\n` +
      `p.stdin.end(process.env.COMPASS_PROMPT+'\\n'+${JSON.stringify(instruction)});p.on('exit',code=>process.exit(code??1));\n`);
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
  };
  /** Stand-in for an Agent that is still running when its Runner dies: records its PID and waits without touching anything. */
  const holdingRole = async (name, targets) => {
    const path = join(directory, name + '.mjs');
    await writeFile(path, `import {writeFileSync} from 'node:fs';\nif (!${JSON.stringify(targets)}.includes(process.env.COMPASS_SUBJECT_ID)) process.exit(0);\n` +
      `writeFileSync(${JSON.stringify(join(directory, name + '.pid'))}, String(process.pid));\nsetInterval(() => {}, 60_000);\n`);
    return `${JSON.stringify(process.execPath)} ${JSON.stringify(path)}`;
  };
  const executable = async (name, body) => { const path = join(directory, name); await writeFile(path, body); await chmod(path, 0o755); return path; };
  const ralphCodex = await executable('ralph-codex', '#!/usr/bin/env bash\n# Ralph codex provider with the development Wacha MCP disabled.\nexec codex "$1" -c mcp_servers.wacha.enabled=false "${@:2}"\n');
  const ralphHold = await executable('ralph-hold', `#!/usr/bin/env bash\n# Stand-in provider: keeps the resumed Prompt and waits; never writes to the worktree.\ncat >${JSON.stringify(join(directory, 'ralph-hold-prompt.md'))}\necho $$ >${JSON.stringify(join(directory, 'ralph-hold.pid'))}\nexec sleep 600\n`);
  const orchestrator = async (label, config, extra = {}) => {
    const path = join(directory, label + '.json');
    await writeFile(path, JSON.stringify({ serverUrl: origin, leaseMs: 240_000, maxAttempts: 3, retryBackoffMs: 0, maxConcurrent: 20, ...config }));
    return { args: ['--import', 'tsx', join(root, 'orchestrator/src/main.ts'), '--config', path, '--once'], env: extra };
  };
  const ralph = async (label, role, config) => {
    const path = join(directory, label + '.json');
    await writeFile(path, JSON.stringify({ serverUrl: origin, projectId, agentProvider: 'codex', ...config }));
    return [join(root, 'ralph/bin/ralph'), 'run', role, '--config', path, '--once'];
  };
  const ralphEnv = { VERIFY_WORKER: actors.worker, VERIFY_REVIEWER: actors.reviewer, VERIFY_MANAGER: actors.manager };
  const changes = async () => (await mcp('manager', 'list_changes', { projectId, limit: 500 })).changes;

  // --- 1. Project Consultation: the Worker waits with uncommitted artifacts, the Human replies on the Web.
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
  const inspectRuntime = () => JSON.parse(execFileSync(process.execPath, [join(root, 'ralph/runtime/consultation-context.mjs'), metadata], { encoding: 'utf8' }));
  const runtime = inspectRuntime();
  await mcp('worker', 'wait_for_consultation', { taskId: task.id, claimId: work.claimId, consultationIds: [consultationId], reason: 'Humanの選択待ち', runtime });
  step('waiting_human', { taskId: task.id, consultationId, claimId: work.claimId, runtime });
  const reply = await human('POST', `/api/projects/${projectId}/consultations/${consultationId}/messages`, { body: 'blueを選びます。この検証成果物にblueを記録してください。', requestId: crypto.randomUUID() });
  const inputRevision = reply.consultation?.revision;
  step('human_replied', { consultationId, inputRevision });
  await save();

  // --- 2. Orchestrator crash: kill the Runner while its Manager dispatch is running, restart it, then recover the dispatch.
  const dispatchKey = `${workspaceId}:${projectId}:manager:consultation:${consultationId}:${inputRevision}`;
  const consultationProjects = (command) => ({ stateDir: join(directory, 'dispatch'), consultationProjects: [{ projectId, tokenEnv: 'VERIFY_RUNTIME', agentEnv: { VERIFY_MANAGER: actors.manager } }], roles: { manager: { command } } });
  const record = async () => (await readJson(join(directory, 'dispatch/dispatches.json'))).records[dispatchKey];
  const holding = await orchestrator('orchestrator-hold', consultationProjects(await holdingRole('manager-hold', [consultationId])), { VERIFY_RUNTIME: projectToken });
  const crashed = await start('orchestrator-1-killed', process.execPath, holding.args, { env: holding.env });
  const holdPid = Number(await waitFor('the held Manager dispatch', async () => {
    try { return (await readFile(join(directory, 'manager-hold.pid'), 'utf8')).trim(); } catch { return null; }
  }));
  const held = await waitFor('the running dispatch record', async () => { try { const value = await record(); return value?.childPid ? value : null; } catch { return null; } });
  process.kill(-crashed.child.pid, 'SIGKILL');
  await crashed.exit;
  assert.ok(alive(holdPid), 'The dispatched Agent must outlive the killed Orchestrator');
  step('orchestrator_killed', { dispatchKey, record: held, agentAlive: true });
  const managerCommand = await realRole('manager-real', { role: 'manager', tokenEnv: 'VERIFY_MANAGER', targets: [consultationId],
    instruction: '専用検証Projectの指定された相談だけを処理する。指定以外のMCP・Wacha・Repositoryを操作しない。Humanの色の選択が明確ならcurrent revisionのleaseを取得し、そのHuman messageを根拠に結論を保存する。文書反映は依頼しない。TaskのAcceptはしない。' });
  const realManager = await orchestrator('orchestrator-real', consultationProjects(managerCommand), { VERIFY_RUNTIME: projectToken });
  await run('orchestrator-2-agent-alive', process.execPath, realManager.args, { env: realManager.env });
  assert.deepEqual(await record(), held, 'A restarted Orchestrator must not launch a second Agent while the previous one is alive');
  const whileHeld = await mcp('manager', 'get_consultation', { projectId, consultationId });
  assert.equal(whileHeld.consultation.status, 'waiting_agent');
  assert.equal(whileHeld.consultation.revision, inputRevision);
  step('orchestrator_restarted_without_duplicate', { record: await record(), status: whileHeld.consultation.status, messages: whileHeld.messages.length });
  process.kill(-held.childPid, 'SIGTERM');
  await waitFor('the held Agent to stop', () => !alive(holdPid));
  await run('orchestrator-3-recovered', process.execPath, realManager.args, { env: realManager.env });
  const recovered = await record();
  assert.equal(recovered.status, 'succeeded');
  assert.equal(recovered.attempt, 2);
  const resolved = await mcp('manager', 'get_consultation', { projectId, consultationId });
  assert.equal(resolved.consultation.status, 'resolved', 'Real Manager did not resolve the Human input');
  const humanMessages = (value) => value.messages.filter((item) => item.author.kind === 'human').map((item) => item.id);
  assert.deepEqual(humanMessages(resolved), humanMessages(whileHeld), 'Recovery must not duplicate or lose the Human input');
  step('real_manager_resolved_after_restart', { record: recovered, revision: resolved.consultation.revision, resolutionId: resolved.consultation.resolutionId,
    messages: resolved.messages.map((item) => item.author.kind) });
  await save();

  // --- 3. Ralph Runner crash: kill the Runner after it resumed the Task, restart it, then resume again after the Claim expires.
  const workerPrompt = join(directory, 'worker.md');
  await writeFile(workerPrompt, 'Compassのworkerとして専用検証Taskだけを再開する。末尾の取得済みContextを使用しClaimし直さない。Role Contextと再開Skill・保存Context・全相談の結論・現在Taskを確認する。結論の色をresumed.txtへ1行で保存しevidence.txtを保持する。Task Commentとcomplete_taskでin_reviewまで進める。commit/push/Accept・他Task・Wacha操作は禁止。');
  const resumptionOf = async () => (await mcp('worker', 'list_consultation_resumptions', { projectId })).resumptions.find((item) => item.taskId === task.id);
  assert.equal((await resumptionOf()).state, 'ready');
  const holdingRalph = await ralph('ralph-hold', 'worker', { projectRoot: artifacts, roles: { worker: { tokenEnv: 'VERIFY_WORKER', prompt: workerPrompt, command: ralphHold } } });
  const resumeArgs = await ralph('ralph-real', 'worker', { projectRoot: artifacts, roles: { worker: { tokenEnv: 'VERIFY_WORKER', prompt: workerPrompt, command: ralphCodex } } });
  const runner = await start('ralph-1-killed', 'bash', holdingRalph, { env: ralphEnv });
  const agentPid = Number(await waitFor('the resumed provider', async () => {
    try { return (await readFile(join(directory, 'ralph-hold.pid'), 'utf8')).trim(); } catch { return null; }
  }));
  const firstResume = await resumptionOf();
  assert.equal(firstResume.state, 'resuming');
  assert.match(await readFile(join(directory, 'ralph-hold-prompt.md'), 'utf8'), /相談からの再開Context/);
  // The lock wrapper started the loop in its own session; kill the wrapper and the loop, keep the provider (old Agent).
  const loopPid = Number(execFileSync('ps', ['-axo', 'pid=,ppid='], { encoding: 'utf8' }).trim().split('\n')
    .map((line) => line.trim().split(/\s+/).map(Number)).find(([, parent]) => parent === runner.child.pid)?.[0]);
  assert.ok(loopPid);
  process.kill(runner.child.pid, 'SIGKILL');
  process.kill(loopPid, 'SIGKILL');
  await runner.exit;
  assert.ok(alive(agentPid), 'The provider must outlive the killed Runner');
  step('ralph_killed', { resumption: firstResume.state, runnerPid: runner.child.pid, loopPid, agentAlive: true });
  await run('ralph-2-lock-held', 'bash', resumeArgs, { env: ralphEnv, expectCode: 75 });
  step('ralph_restart_refused_by_worktree_lock', { exitCode: 75 });
  process.kill(-loopPid, 'SIGKILL');
  await waitFor('the old provider to stop', () => !alive(agentPid));
  assert.deepEqual(inspectRuntime(), runtime, 'The killed run must leave the saved worktree unchanged');
  await run('ralph-3-claim-live', 'bash', resumeArgs, { env: ralphEnv });
  assert.equal((await resumptionOf()).state, 'resuming', 'A live resumption Claim must not be resumed twice');
  step('ralph_restart_while_claim_live', { state: 'resuming', worktreeUnchanged: true });
  await save();
  await waitFor('the resumption Claim to expire', async () => (await resumptionOf()).state === 'ready', claimTtlMs + 30_000);
  step('resumption_claim_expired', { state: 'ready' });
  await run('ralph-4-resumed', 'bash', resumeArgs, { env: ralphEnv });
  const current = (await mcp('worker', 'list_tasks', { projectId })).tasks.find((item) => item.id === task.id);
  assert.ok(current, 'Verification Task is missing');
  assert.equal(current.status, 'in_review');
  assert.equal((await readFile(join(artifacts, 'resumed.txt'), 'utf8')).trim(), 'blue');
  assert.deepEqual(await readFile(join(artifacts, 'evidence.txt')), preserved);
  assert.deepEqual(await readFile(contextPath), Buffer.from(JSON.stringify({ reason: 'Human selection is pending', headSha })));
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: artifacts, encoding: 'utf8' }).trim(), headSha);
  assert.equal(execFileSync('git', ['worktree', 'list', '--porcelain'], { cwd: artifacts, encoding: 'utf8' }).match(/^worktree /gm).length, 1);
  const resumes = (await changes()).filter((change) => change.entityId === task.id && change.type === 'TASK_CONSULTATION_RESUMING');
  assert.equal(resumes.length, 2, 'One resumption before the crash and one after the Claim expired');
  const notes = await mcp('worker', 'list_task_comments', { taskId: task.id });
  const resumedNotes = notes.comments.filter((item) => item.principalId === actors.worker && item.claimId !== work.claimId);
  assert.ok(resumedNotes.length > 0, 'No verification note from the resumed Claim');
  assert.ok(resumedNotes.every((item) => item.claimId === resumes[1].claimId), 'Only the Claim taken after expiry may act');
  evidence.resumedClaimId = resumes[1].claimId;
  step('real_worker_resumed', { taskId: task.id, state: current.status, resumptionClaims: resumes.map((change) => change.claimId), artifactsPreserved: true, worktrees: 1 });
  await save();

  // --- 4. Workspace Consultation answered by a real Strategist through the Workspace Orchestrator.
  const workspaceConsultation = await mcp('strategist', 'create_consultation', { workspaceId, title: '検証用の文書方針',
    question: '専用検証Projectの仕様には、相談の結論を反映する文書の置き場所をどう決めますか', blockingReason: 'Mission・Principlesから決められない',
    recommendation: 'docs/specs/consultation-reflection.md に置く', impact: '専用検証ProjectのRepositoryのみ',
    options: [{ label: 'docs/specs/consultation-reflection.md' }, { label: 'README.md' }] });
  const workspaceConsultationId = workspaceConsultation.consultation?.id ?? workspaceConsultation.id;
  // A Workspace Consultation carries projectId null, which the policy does not record as an in-scope Entity; observe it by Workspace.
  client.observe({ workspaceId }, { id: workspaceConsultationId });
  const workspaceReply = await human('POST', `/api/workspaces/${workspaceId}/consultations/${workspaceConsultationId}/messages`,
    { body: 'docs/specs/consultation-reflection.md に置いてください。結論は専用検証Projectへ引き継いでください。', requestId: crypto.randomUUID() });
  step('workspace_human_replied', { workspaceConsultationId, inputRevision: workspaceReply.consultation?.revision });
  const strategistCommand = await realRole('strategist-real', { role: 'strategist', tokenEnv: 'VERIFY_STRATEGIST', targets: [workspaceConsultationId],
    instruction: `専用検証Workspaceの指定された相談だけを処理する。指定以外のMCP・Wacha・Repositoryを操作しない。Humanの選択が明確ならcurrent revisionのleaseを取得し、そのHuman messageを根拠に結論を保存し、hand_off_consultationで引継ぎ先Project ${projectId} を指定する。Intent・Outcome・他の相談は変更しない。` });
  const workspaceRun = await orchestrator('orchestrator-workspace', { stateDir: join(directory, 'dispatch-workspace'),
    workspaces: [{ workspaceId, tokenEnv: 'VERIFY_WORKSPACE_RUNTIME', agentEnv: { VERIFY_STRATEGIST: actors.strategist }, projects: [] }],
    roles: { strategist: { command: strategistCommand } } }, { VERIFY_WORKSPACE_RUNTIME: workspaceToken });
  await run('orchestrator-workspace', process.execPath, workspaceRun.args, { env: workspaceRun.env });
  const workspaceResolved = await mcp('strategist', 'get_consultation', { workspaceId, consultationId: workspaceConsultationId });
  assert.equal(workspaceResolved.consultation.status, 'resolved', 'Real Strategist did not resolve the Workspace Consultation');
  const handoff = await mcp('manager', 'get_consultation_handoff_context', { projectId, workspaceId, consultationId: workspaceConsultationId });
  step('real_strategist_resolved', { workspaceConsultationId, revision: workspaceResolved.consultation.revision,
    resolutionId: workspaceResolved.consultation.resolutionId, handedOffTo: projectId, conclusion: handoff.resolution?.conclusion });
  await save();

  // --- 5. Document reflection by real Agents: Manager request → Worker commit → Reviewer → Manager acceptance and reference.
  const docs = join(directory, 'verification-docs');
  const git = (...args) => execFileSync('git', args, { cwd: docs, encoding: 'utf8' }).trim();
  await mkdir(docs);
  git('init', '-q', '-b', 'main');
  await writeFile(join(docs, 'README.md'), '# verification-docs\n\n相談の結論を反映する専用検証Repository。\n');
  await writeFile(join(docs, '.git/info/exclude'), '.compass-ralph/\n');
  git('add', 'README.md');
  git('-c', 'user.email=preview-owner@example.test', '-c', 'user.name=preview-owner', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'docs: initialize');
  const baseCommit = git('rev-parse', 'HEAD');
  const followupManager = join(directory, 'followup-manager.mjs');
  await writeFile(followupManager, `import {spawn} from 'node:child_process';\nconst p=spawn('codex',${JSON.stringify(codexArgs('manager', 'VERIFY_MANAGER'))},{cwd:${JSON.stringify(directory)},env:process.env,stdio:['pipe','inherit','inherit']});\n` +
    `p.stdin.end(${JSON.stringify(`Compassのmanagerとして専用検証Project ${projectId} だけを扱う。get_role_context({ projectId: "${projectId}", role: "manager" })でRole Contextを取得する。Workspace ${workspaceId} の相談 ${workspaceConsultationId} はStrategistがこのProjectへ引き継いだ。get_consultation_handoff_contextで結論を読み、Repository ${repository.id}（verification-docs）へ結論を反映するspecificationの文書反映をrequest_consultation_followupで依頼する。文書pathは結論に従う。他のTask・相談・Wachaは操作しない。`)});p.on('exit',code=>process.exit(code??1));\n`);
  await run('manager-followup', process.execPath, [followupManager], { env: { VERIFY_MANAGER: actors.manager } });
  const requested = await mcp('manager', 'get_consultation_handoff_context', { projectId, workspaceId, consultationId: workspaceConsultationId });
  assert.equal(requested.followups.length, 1, 'Real Manager did not request exactly one document follow-up');
  const followup = requested.followups[0];
  step('real_manager_requested_followup', { followupId: followup.id, taskId: followup.taskId, kind: followup.kind, status: followup.status });
  const docsPrompt = (role) => join(directory, `docs-${role}.md`);
  await writeFile(docsPrompt('worker'), `Compassのworkerとして文書反映Task ${followup.taskId} だけを扱う。claim_taskで取得し、Task本文の決定をこのRepositoryの文書へ反映する。変更した文書だけをgit add し、git -c user.email=preview-worker@example.test -c user.name=preview-worker -c commit.gpgsign=false commit でcommitする（pushしない）。commit SHAとpathをTask Commentに残しcomplete_taskでin_reviewへ進める。他Task・Wachaは操作しない。`);
  await writeFile(docsPrompt('reviewer'), `Compassのreviewerとして文書反映Task ${followup.taskId} だけを扱う。claim_reviewで取得し、Task Commentのcommitをgit showで確認する。Task本文の決定と検証方法を満たせばTask Commentを残しreviewed_taskで承認する。不足ならreject_taskする。ファイルを変更しない。他Task・Wachaは操作しない。`);
  await writeFile(docsPrompt('manager'), `Compassのmanagerとして文書反映Task ${followup.taskId} だけを扱う。claim_acceptanceで取得し、Task Commentのcommitをgit showで確認する。要件を満たせばaccept_taskのdeliverablesへRepository ${repository.id}・40文字のcommitSha・変更pathを入れて受け入れる。続けてProject ${projectId}・Workspace ${workspaceId}・相談 ${workspaceConsultationId}・follow-up ${followup.id} でrecord_consultation_artifactを呼び、受入れたpathとcommitを登録する（pullRequestUrlはnull）。ファイルを変更しない。他Task・Wachaは操作しない。`);
  for (const role of ['worker', 'reviewer', 'manager']) {
    const args = await ralph(`ralph-docs-${role}`, role, { projectRoot: docs,
      ...(role === 'worker' ? { codex: { dangerouslyBypassApprovalsAndSandbox: true } } : {}),
      roles: { [role]: { tokenEnv: `VERIFY_${role.toUpperCase()}`, prompt: docsPrompt(role), command: ralphCodex } } });
    await run(`ralph-docs-${role}`, 'bash', args, { env: ralphEnv });
    const docsTask = (await mcp(role, 'list_tasks', { projectId })).tasks.find((item) => item.id === followup.taskId);
    step(`real_${role}_document_task`, { taskId: followup.taskId, status: docsTask?.status });
  }
  const reflected = await mcp('manager', 'get_consultation_handoff_context', { projectId, workspaceId, consultationId: workspaceConsultationId });
  const done = reflected.followups.find((item) => item.id === followup.id);
  assert.equal(done.status, 'reflected', 'Real Manager did not record the accepted document');
  assert.equal(done.artifacts.length, 1);
  const [artifact] = done.artifacts;
  assert.equal(git('rev-list', '--count', `${baseCommit}..HEAD`), '1');
  assert.equal(artifact.commitSha, git('rev-parse', 'HEAD'));
  assert.ok(git('show', '--name-only', '--format=', artifact.commitSha).split('\n').includes(artifact.path));
  assert.equal(git('status', '--porcelain'), '');
  const resent = await mcp('manager', 'record_consultation_artifact', { projectId, workspaceId, consultationId: workspaceConsultationId,
    followupId: followup.id, taskId: followup.taskId, repositoryId: repository.id, path: artifact.path, commitSha: artifact.commitSha, pullRequestUrl: null });
  assert.equal(resent.artifact.id, artifact.id, 'A resent reference must return the saved artifact');
  step('real_document_reflected', { followupId: followup.id, taskStatus: done.task?.status, path: artifact.path, commitSha: artifact.commitSha, resentSameArtifact: true });
  await save();

  // --- 6. Server restart on the same DB: Consultations, conclusions, waits and artifact references stay traceable.
  const snapshot = async () => ({
    project: await human('GET', `/api/projects/${projectId}/consultations/${consultationId}`),
    workspace: await human('GET', `/api/workspaces/${workspaceId}/consultations/${workspaceConsultationId}`),
    tasks: (await mcp('worker', 'list_tasks', { projectId })).tasks.map(({ id, status }) => ({ id, status })),
  });
  const before = await snapshot();
  await database.destroy();
  database = undefined;
  startServer();
  const after = await snapshot();
  assert.deepEqual(after, before, 'Server restart on the same DB changed the observed state');
  await writeFile(join(directory, 'persistence.json'), JSON.stringify({ before, after }, null, 2));
  step('server_restarted_same_db', { equal: true, snapshot: join(directory, 'persistence.json') });
  evidence.result = 'passed';
} catch (error) {
  evidence.result = 'failed'; evidence.error = error.message; process.exitCode = 1;
} finally {
  for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  // Orchestrator launches separate process groups; stop only this run's unfinished dispatches.
  try { await stopDispatches(); }
  catch (error) { evidence.cleanupError = error.message; evidence.result = 'failed'; process.exitCode = 1; }
  for (const name of ['manager-hold.pid', 'ralph-hold.pid']) {
    try { const pid = Number(await readFile(join(directory, name), 'utf8')); if (alive(pid)) process.kill(pid, 'SIGKILL'); } catch {}
  }
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  if (database) await database.destroy();
  evidence.finishedAt = new Date().toISOString(); await save();
  console.log(JSON.stringify({ result: evidence.result, headSha, evidencePath: join(directory, 'evidence.json'), error: evidence.error }));
}
