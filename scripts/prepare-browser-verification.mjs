#!/usr/bin/env node
/** Dedicated Manager preview fixtures. Product records use the inspected checkout's application services. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: { 'data-dir': { type: 'string' } } });
if (!values['data-dir'] || !isAbsolute(values['data-dir'])) throw new Error('--data-dir must be an absolute dedicated preview directory');
const root = await realpath(process.cwd());
const data = await realpath(values['data-dir']);
const requestedDatabasePath = resolve(process.env.COMPASS_DB_PATH ?? '');
const databasePath = join(await realpath(dirname(requestedDatabasePath)), basename(requestedDatabasePath));
if (process.env.COMPASS_AUTH_MODE !== 'trusted-local' || databasePath !== join(data, 'preview.db')) {
  throw new Error('Preparation requires trusted-local and COMPASS_DB_PATH=<data-dir>/preview.db');
}
const ownerEmail = process.env.COMPASS_INITIAL_OWNER_EMAIL;
if (!ownerEmail?.endsWith('@example.test')) throw new Error('Preparation requires a preview owner in example.test');
const requireTarget = createRequire(join(root, 'package.json'));
for (const name of ['access', 'direction', 'organization', 'work']) {
  const entry = await realpath(requireTarget.resolve(`@compass/${name}`));
  if (!entry.startsWith(join(root, 'packages', name) + sep)) {
    throw new Error(`@compass/${name} must resolve inside the inspected checkout; install its workspace dependencies first`);
  }
}
const headSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const targetModule = async (name) => {
  const path = await realpath(join(root, name));
  if (relative(root, path).startsWith('..')) throw new Error('Target module escapes the inspected checkout');
  return import(pathToFileURL(path).href);
};
// Exclusive creation protects every existing database, including a previous failed preparation.
const reserved = await open(databasePath, 'wx', 0o600);
await reserved.close();
const { createDatabase } = await targetModule('server/src/bootstrap/database/createDatabase.ts');
const { initializeSchema } = await targetModule('server/src/bootstrap/database/initializeSchema.ts');
const { createApplicationServices } = await targetModule('server/src/bootstrap/createApplicationServices.ts');
const database = createDatabase(databasePath);
const identities = { manager: 'preview-manager', worker: 'preview-worker', reviewer: 'preview-reviewer', strategist: 'preview-strategist', evaluator: 'preview-evaluator' };
const viewerEmail = 'preview-viewer@example.test';
let sequence = 0;
const key = (name) => `preview:${name}:${++sequence}`;
const scenarios = [];
let availableTools = [];
try {
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: ownerEmail });
  const login = await services.localDevLoginUseCase.execute({ email: ownerEmail, previousSessionToken: null });
  if (login.kind !== 'logged_in') throw new Error('Preview owner could not be registered');
  const owner = { kind: 'human', humanUserId: login.session.humanUserId };
  const direction = services.workspaceDirection;
  const work = services.taskCoordinationService;
  // Read the inspected revision's public MCP contract; never advertise absent operations.
  const { createApp } = await targetModule('server/src/bootstrap/app.ts');
  const app = createApp(services, { humanAuth: { mode: 'trusted-local', publicOrigin: 'http://localhost' } });
  const listed = await app.request('/mcp', { method: 'POST', headers: {
    'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
    Authorization: `Bearer ${identities.manager}`, 'X-Compass-Active-Role': 'manager',
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 'preview-tools', method: 'tools/list' }) });
  if (!listed.ok) throw new Error('Could not inspect preview MCP capabilities');
  const raw = await listed.text();
  const payload = JSON.parse(raw.split('\n').find((line) => line.startsWith('data: '))?.slice(6) ?? raw);
  if (!Array.isArray(payload.result?.tools)) throw new Error('Invalid preview MCP tools/list response');
  availableTools = payload.result.tools.map(({ name }) => name);
  const addViewer = async (workspaceId, projectId) => {
    const invitation = await services.createProjectInvitationUseCase.execute(owner, projectId, { email: viewerEmail, role: 'viewer' });
    const signedIn = await services.localDevLoginUseCase.execute({ email: viewerEmail, invitationToken: invitation.token, previousSessionToken: null });
    if (signedIn.kind !== 'logged_in') throw new Error('Preview viewer invitation could not be accepted');
    const humanUserId = signedIn.session.humanUserId;
    const members = await services.human.listWorkspaceMembers.execute(owner, workspaceId);
    if (!members.some(({ human }) => human.id === humanUserId)) {
      await services.human.addWorkspaceMember.execute(owner, workspaceId, { humanUserId, role: 'viewer' });
    }
    return humanUserId;
  };
  const acceptedWork = async (project, outcome, label) => {
    const story = await work.issueStory(identities.manager, { projectId: project.id, outcomeId: outcome.id, title: `${label}のStory` }, key('story'));
    const task = await work.issueTask(identities.manager, { projectId: project.id, storyId: story.id, taskKey: `preview-${label}`, title: `${label}のTask` }, key('task'));
    const claim = await work.claimTask(identities.worker, task.id, key('claim'));
    await work.addTaskComment(identities.worker, task.id, claim.claimId, '画面検証専用の決定的fixture。実Agentの成果ではない。', key('comment'));
    await work.completeTask(identities.worker, task.id, claim.claimId, key('complete'));
    const review = await work.claimReview(identities.reviewer, task.id, key('review'));
    await work.reviewedTask(identities.reviewer, task.id, review.claimId, key('reviewed'));
    const acceptance = await work.claimAcceptance(identities.manager, task.id, key('acceptance'));
    await work.acceptTask(identities.manager, task.id, acceptance.claimId, key('accept'));
    const changes = await work.listChanges(identities.manager, project.id);
    const reflected = await direction.recordExecutionEvidenceUseCase.execute('preview-runtime', project.workspaceId, project.id, outcome.id, {
      changeCursor: changes.nextCursor,
      evidence: [{ kind: 'url', uri: `https://example.test/fixtures/${project.id}`, versionHash: headSha, observedAt: Date.now() - 1_000 }],
    });
    return { projectId: project.id, storyId: story.id, taskId: task.id, evidenceIds: reflected.evidence.map(({ id }) => id) };
  };
  for (const scenario of ['no-target', 'partial-work', 'evaluated']) {
    const name = { 'no-target': '[受入] Targetなし', 'partial-work': '[受入] 一部Project未着手', evaluated: '[受入] 複数Targetと評価根拠' }[scenario];
    const workspace = await services.human.createWorkspace.execute({ name, mission: '保存済みデータからDirectionの表示・遷移・権限差を検証する' }, owner);
    for (const role of ['strategist', 'evaluator']) await services.grantWorkspaceRoleUseCase.execute(workspace.id, { principalId: identities[role], role });
    const intent = await direction.createIntentUseCase.execute(workspace.id, { title: `${name} Intent`, desiredState: '各Projectの貢献と判断根拠が追跡できる' });
    const outcome = await direction.createOutcomeUseCase.execute(workspace.id, intent.id, {
      title: `${name} Outcome`, description: 'Managerの表示・参照検証専用。実運用の成果ではない。', rationale: '画面受入の前提データ',
      successCriteria: [
        { description: 'Target別のStoryとEvidenceを参照できる', measurement: 'Project別の保存データと画面リンクを照合する', target: '全Target' },
        { description: '権限に応じてWorkと編集導線が制限される', measurement: 'ownerとviewerで実API・実画面を比較する', target: '越権なし' },
      ],
    });
    const entry = { scenario, workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id, projects: [], work: [],
      paths: { direction: `/workspaces/${workspace.id}/direction`, outcome: `/workspaces/${workspace.id}/direction/intents/${intent.id}/outcomes/${outcome.id}` } };
    if (scenario !== 'no-target') {
      for (const label of ['A', 'B']) {
        const project = await services.human.createWorkspaceProject.execute(owner, workspace.id, { name: `${name} Project ${label}` });
        for (const role of ['manager', 'worker', 'reviewer']) await services.grantProjectRoleUseCase.execute(project.id, { principalId: identities[role], role });
        await direction.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, project.id);
        entry.projects.push({ id: project.id, label, name: project.name });
        if (label === 'A') entry.viewerHumanUserId = await addViewer(workspace.id, project.id);
        if (label === 'A' || scenario === 'evaluated') entry.work.push(await acceptedWork(project, outcome, label));
      }
    }
    if (scenario === 'evaluated') {
      const request = await direction.createResearchRequestUseCase.execute(workspace.id, { requestKey: key('research'), kind: 'decision', originIntentId: intent.id,
        question: 'Target別のEvidenceと権限をどう確認するか', scope: '専用プレビューの2つのProject', completionCondition: '表示する根拠が保存される', budgetTotal: 10 });
      const result = await direction.registerResearchResultUseCase.execute(workspace.id, request.id, { requestKey: key('research-result'), principalId: identities.strategist,
        runRef: 'browser-preview-fixture', summary: 'Projectごとの還流参照を確認するためのfixture', budgetUsed: 1,
        evidenceRefs: [{ kind: 'url', uri: 'https://example.test/fixtures/research', retrievedAt: Date.now() - 1_000 }],
        findings: [{ statement: 'Target別にEvidenceが保存されている', confidence: 'high', observedAt: Date.now() - 1_000, evidenceIndexes: [0] }] });
      const synthesis = await direction.registerResearchSynthesisUseCase.execute(workspace.id, request.id, { requestKey: key('synthesis'), principalId: identities.strategist,
        runRef: 'browser-preview-fixture', conclusion: 'Projectごとの根拠を辿って表示を検証する', findingIds: result.findings.map(({ id }) => id), validAsOf: Date.now() - 1_000 });
      await direction.completeResearchRequestUseCase.execute(workspace.id, request.id, { conclusion: 'completed' });
      const evidenceIds = entry.work.flatMap(({ evidenceIds }) => evidenceIds);
      const saved = await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, identities.evaluator, outcome.id, { requestKey: key('evaluation'), runRef: 'browser-preview-fixture',
        criteria: outcome.successCriteria.map((criterion, index) => ({ criterionId: criterion.id, verdict: index === 0 ? 'met' : 'not_met',
          rationale: index === 0 ? '専用fixtureの保存済み参照' : '比較表示用の未充足判定。製品の不具合判定ではない。', evidenceIds })) });
      const decision = await direction.createDirectionDecisionUseCase.execute(workspace.id, identities.strategist, { intentId: intent.id, evaluationId: saved.evaluation.id,
        type: 'additional_research', judgment: '権限差の検証条件を追加調査する', reason: '画面上でEvaluationとDecisionの関連を確認するfixture',
        requestKey: key('decision'), runRef: 'browser-preview-fixture', usedSyntheses: [{ synthesisId: synthesis.id, version: synthesis.version }],
        research: { question: 'viewerの見え方を比較する', scope: '専用プレビューのみ', completionCondition: 'アクセス制御を独立に検証できる', budgetTotal: 10 } });
      Object.assign(entry, { researchRequestId: request.id, evaluationId: saved.evaluation.id, decisionId: decision.decision.id,
        expectedVerdicts: ['met', 'not_met'] });
    }
    scenarios.push(entry);
  }
} finally {
  await database.destroy();
}
const scriptSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const manifest = { schemaVersion: 1, purpose: 'browser-verification-fixtures', headSha, preparationScriptSha256: scriptSha256,
  repositoryRoot: root, databasePath, createdAt: new Date().toISOString(),
  dataPreparation: {
    policyPath: resolve(dirname(fileURLToPath(import.meta.url)), '../docs/browser-verification.md'),
    scope: 'isolated-preview-only', endpointPath: '/mcp', actors: identities,
    projectIds: scenarios.flatMap(({ projects }) => projects.map(({ id }) => id)),
    allowedTools: ['issue_story', 'issue_task', 'get_story', 'get_task', 'list_stories', 'list_tasks',
      'claim_task', 'claim_review', 'claim_acceptance', 'renew_claim', 'release_claim',
      'add_task_comment', 'complete_task', 'reviewed_task', 'accept_task',
      'create_consultation', 'list_consultations', 'get_consultation', 'acquire_consultation_lease',
      'reply_consultation', 'resolve_consultation', 'cancel_consultation',
      'wait_for_consultation', 'list_consultation_resumptions', 'resume_consultation_task',
      'confirm_consultation_continuation'].filter((name) => availableTools.includes(name)),
    consultationResumptionEnabled: ['wait_for_consultation', 'list_consultation_resumptions',
      'resume_consultation_task', 'confirm_consultation_continuation'].every((name) => availableTools.includes(name)),
    runtimeArtifacts: {
      scope: 'dedicated-verification-directory-only',
      instructions: 'Save a separate temporary Git checkout at this headSha, uncommitted artifacts and previous Context. Use the inspected revision runtime/consultation-context.mjs. Do not use or modify the actual acceptance execution Worktree/Context.',
    },
    claimTtlMs: Number(process.env.COMPASS_CLAIM_TTL_MS ?? 30 * 60 * 1000),
    instructions: 'Read policyPath. Use only the dedicated preview URL and these preview actors; execution Task/Claim and operational MCP are outside this permission.',
  },
  login: { mode: 'trusted-local', ownerEmail, viewerEmail, instructions: 'ログイン画面からemailを入力する。viewerはProject Aのみ所属し、Project Bは未所属。' },
  scenarios, limitations: ['データ準備は公開APIによる管理操作のAC検証ではない', '判定・Evidenceは表示確認用fixtureであり、実Agentの自律運転や実成果を示さない'] };
const manifestPath = join(data, 'browser-fixtures.json');
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ manifestPath, headSha, dataPreparation: manifest.dataPreparation,
  scenarios: scenarios.map(({ scenario, workspaceId, outcomeId }) => ({ scenario, workspaceId, outcomeId })) }));
