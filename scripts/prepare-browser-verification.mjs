#!/usr/bin/env node
/** Dedicated Manager preview fixtures. Product records use the inspected checkout's application services. */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdir, open, readFile, realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { classifyTool, createPreviewMcpClient, PreviewOperationError, previewOperationPolicy } from './preview-operation-policy.mjs';

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
const { deriveCsrfToken } = await targetModule('packages/access/src/index.ts');
const { GitHubPullRequestGateway } = await targetModule('packages/work/src/index.ts');
const database = createDatabase(databasePath);
const identities = { manager: 'preview-manager', worker: 'preview-worker', reviewer: 'preview-reviewer', strategist: 'preview-strategist', evaluator: 'preview-evaluator' };
const viewerEmail = 'preview-viewer@example.test';
let sequence = 0;
const planIdsOf = (outcome, indexes) => Object.fromEntries(indexes.flatMap((index) => outcome.problems[index].evaluationPlan ? [[outcome.problems[index].id, outcome.problems[index].evaluationPlan.planId]] : []));
const key = (name) => `preview:${name}:${++sequence}`;
const isoDay = (offset) => new Date(Date.now() - offset * 86_400_000).toISOString().slice(0, 10);
// Intent metric observations and Agent explanations (UI-M2). Strategist/Evaluator Grants are enforced by the same authorized wrappers
// the MCP tools use. The values are display fixtures, not business results, and are no evidence that an Agent ran.
const prepareIntentExplanations = async (services, workspaceId, projectId, intent, outcome, refs) => {
  const strategist = identities.strategist;
  const evaluator = identities.evaluator;
  const source = { name: '検証用の集計表', uri: 'https://example.test/fixtures/metrics' };
  const observation = (offset, value) => ({ periodStart: isoDay(offset), periodEnd: isoDay(offset), status: 'observed', value, source, observedAt: Date.now() - 60_000 });
  const define = (key, name, unit, staleAfterDays) => services.defineIntentMetricUseCase.execute(strategist, workspaceId, intent.id,
    { key, name, unit, targetValue: null, staleAfterDays });
  const record = async (metricKey, observations) => (await services.recordIntentMetricObservationsUseCase.execute(evaluator, workspaceId, intent.id,
    { metricKey, observations })).observations.map(({ observation: saved }) => saved);
  await define('completion_rate', '登録完了率', '%', 7);
  await define('weekly_retention', '継続利用率', '%', 7);
  const [before, after] = await record('completion_rate', [observation(8, 41), observation(1, 47)]);
  const [retentionBefore, retentionAfter] = await record('weekly_retention', [observation(7, 30), observation(1, 31)]);
  const explanationBase = { runRef: 'browser-preview-fixture', relatedOutcomeIds: [outcome.id] };
  // v1 is a short explanation. The earlier day is then corrected and v2 (with every item kind) points back to v1 and uses the corrected value.
  const first = await services.recordIntentExplanationUseCase.execute(strategist, workspaceId, intent.id, { ...explanationBase,
    requestKey: key('explanation-completion'), metricKey: 'completion_rate', periodStart: isoDay(8), periodEnd: isoDay(1),
    items: [
      { kind: 'fact', statement: '登録完了率は41%から47%へ上がった', basis: [{ type: 'metric_observation', id: before.id }, { type: 'metric_observation', id: after.id }] },
      { kind: 'hypothesis', statement: '入力項目の削減が完了率を押し上げた可能性がある', confidence: 'low', verification: '同じ条件の比較を追加する', basedOn: [0] },
    ] });
  const second = await services.recordIntentExplanationUseCase.execute(strategist, workspaceId, intent.id, { ...explanationBase,
    requestKey: key('explanation-retention'), metricKey: 'weekly_retention', periodStart: isoDay(7), periodEnd: isoDay(1),
    items: [
      { kind: 'fact', statement: '継続利用率は30%から31%で、ほぼ横ばい', basis: [{ type: 'metric_observation', id: retentionBefore.id }, { type: 'metric_observation', id: retentionAfter.id }] },
      { kind: 'fact', statement: 'Outcomeの評価は未達で、満たせなかった条件がある', basis: [{ type: 'evaluation', id: refs.evaluationId }] },
      { kind: 'hypothesis', statement: '通知の変更はまだ継続利用に表れていない可能性がある', confidence: 'low', verification: '公開後4週間の週次の継続利用率を観測する', basedOn: [0, 1] },
    ] });
  const [corrected] = await record('completion_rate', [{ ...observation(8, 43), observedAt: Date.now() - 30_000 }]);
  const revised = await services.recordIntentExplanationUseCase.execute(strategist, workspaceId, intent.id, { ...explanationBase,
    requestKey: key('explanation-completion-v2'), metricKey: 'completion_rate', periodStart: isoDay(8), periodEnd: isoDay(1),
    changeFromPrevious: '比較前の値が43%へ訂正されたため、上昇幅を見直した',
    items: [
      { kind: 'fact', statement: '登録完了率は43%から47%へ上がった', basis: [{ type: 'metric_observation', id: corrected.id }, { type: 'metric_observation', id: after.id }] },
      { kind: 'fact', statement: '同じ期間に入力項目を減らす変更が検討されていた', basis: [{ type: 'finding', id: refs.findingId }] },
      { kind: 'hypothesis', statement: '入力項目の削減が上昇に寄与した可能性はあるが、他の要因は切り分けていない', confidence: 'low',
        verification: '変更前後で同じ利用者層を比較し、変更していない導線の完了率も確認する', basedOn: [0, 1], basis: [{ type: 'synthesis', id: refs.synthesisId }] },
      { kind: 'proposal', statement: '評価計画に沿って追加の調査を行い、結果を見てから判断する', basedOn: [2], basis: [{ type: 'decision', id: refs.decisionId }] },
    ] });
  // The latest day is corrected after v2 was recorded: v2 keeps its basis and is flagged as based on a corrected observation.
  await record('completion_rate', [{ ...observation(1, 48), observedAt: Date.now() - 10_000 }]);
  return { metricKeys: ['completion_rate', 'weekly_retention'], explanationIds: { completionRateV1: first.explanation.id, weeklyRetention: second.explanation.id, completionRateV2: revised.explanation.id } };
};
const scenarios = [];
// Project and Workspace Consultations reflected in a real document commit through the normal Work flow.
// Human steps (Repository registration, replies) use the owner's Human use cases and are recorded as in-scope Entities;
// Agent steps use the policy-checked public MCP.
const prepareReflections = async (services, owner, client, entry) => {
  const project = entry.projects.find(({ label }) => label === 'A');
  const updated = await services.human.updateProject.execute(owner, project.id, {
    repositories: [{ name: 'verification-docs', url: 'https://example.test/verification-docs.git' }] });
  const repository = updated.repositories.find(({ name }) => name === 'verification-docs');
  client.observe({ projectId: project.id }, repository);
  // Project Repository URLs accept http(s) only; the dedicated bare repository holds the actual commits.
  const bare = join(data, 'verification-docs.git');
  const checkout = join(data, 'verification-docs');
  const git = (...args) => execFileSync('git', args, { cwd: checkout, encoding: 'utf8' }).trim();
  execFileSync('git', ['init', '-q', '--bare', bare]);
  execFileSync('git', ['clone', '-q', bare, checkout], { stdio: 'ignore' });
  git('config', 'user.email', 'preview-worker@example.test');
  git('config', 'user.name', identities.worker);
  git('config', 'commit.gpgsign', 'false');
  const reflect = async (scope, consultationId, { path, ...followupInput }) => {
    const ids = { projectId: project.id, ...(scope === 'workspace' ? { workspaceId: entry.workspaceId } : {}), consultationId };
    const { followup } = await client.call('manager', 'request_consultation_followup', { ...ids, repositoryId: repository.id, ...followupInput });
    const work = await client.call('worker', 'claim_task', { taskId: followup.taskId });
    await mkdir(join(checkout, dirname(path)), { recursive: true });
    await writeFile(join(checkout, path), `# ${followupInput.title}\n\n## 決定\n\n${followupInput.decision}\n\n## 理由\n\n${followupInput.rationale}\n`);
    git('add', path);
    git('commit', '-q', '-m', `docs: ${followupInput.title}`);
    git('push', '-q', 'origin', 'HEAD');
    const commitSha = git('rev-parse', 'HEAD');
    await client.call('worker', 'add_task_comment', { taskId: followup.taskId, claimId: work.claimId,
      body: `検証用Repositoryへ${path}をcommitした（${commitSha}）。画面検証専用の公開操作であり、実Agentの成果ではない。` });
    await client.call('worker', 'complete_task', { taskId: followup.taskId, claimId: work.claimId });
    const review = await client.call('reviewer', 'claim_review', { taskId: followup.taskId });
    await client.call('reviewer', 'reviewed_task', { taskId: followup.taskId, claimId: review.claimId });
    const acceptance = await client.call('manager', 'claim_acceptance', { taskId: followup.taskId });
    await client.call('manager', 'accept_task', { taskId: followup.taskId, claimId: acceptance.claimId,
      deliverables: [{ repositoryId: repository.id, commitSha, paths: [path], pullRequestUrl: null }] });
    await client.call('manager', 'record_consultation_artifact', { ...ids, followupId: followup.id, taskId: followup.taskId,
      repositoryId: repository.id, path, commitSha, pullRequestUrl: null });
    return { scope, consultationId, followupId: followup.id, taskId: followup.taskId,
      artifact: { repositoryId: repository.id, path, commitSha },
      path: scope === 'project' ? `/projects/${project.id}/consultations/${consultationId}` : `/workspaces/${entry.workspaceId}/consultations/${consultationId}` };
  };
  const conclude = async (role, ids, reply) => {
    const lease = await client.call(role, 'acquire_consultation_lease', { ...ids, inputRevision: reply.consultation.revision });
    await client.call(role, 'resolve_consultation', { ...ids, leaseId: lease.lease.id, expectedRevision: reply.consultation.revision,
      conclusion: reply.conclusion, rationale: 'Humanの返信に基づく検証専用の結論', basisMessageIds: [reply.message.id] });
  };
  const consultationInput = (title, question) => ({ title, question, blockingReason: '検証用の判断が必要',
    options: [{ label: 'A案' }, { label: 'B案' }], recommendation: 'A案', impact: '専用プレビューの検証データのみ' });
  const projectCreated = await client.call('worker', 'create_consultation', { projectId: project.id,
    ...consultationInput('[検証専用] 通知履歴の保存方式', '通知履歴をDBへ保存するかを決めてください') });
  const projectIds = { projectId: project.id, consultationId: projectCreated.consultation.id };
  const projectReply = await services.human.replyConsultation.execute(owner, project.id, projectIds.consultationId,
    { body: 'A案（DBへ保存）で進めてください。', requestId: key('reply') });
  client.observe({ projectId: project.id }, projectReply);
  await conclude('manager', projectIds, { ...projectReply, conclusion: '通知履歴はDBへ保存する' });
  const workspaceCreated = await client.call('strategist', 'create_consultation', { workspaceId: entry.workspaceId,
    ...consultationInput('[検証専用] Workspaceの優先順位', 'Target Projectの優先順位を決めてください') });
  const workspaceIds = { workspaceId: entry.workspaceId, consultationId: workspaceCreated.consultation.id };
  const workspaceReply = await services.human.replyWorkspaceConsultation.execute(owner, entry.workspaceId, workspaceIds.consultationId,
    { body: 'A案（Project Aを優先）で進めてください。', requestId: key('reply') });
  client.observe({ workspaceId: entry.workspaceId }, workspaceReply);
  await conclude('strategist', workspaceIds, { ...workspaceReply, conclusion: 'Project Aを優先する' });
  await client.call('strategist', 'hand_off_consultation', { ...workspaceIds, projectId: project.id });
  const reflected = [
    await reflect('project', projectIds.consultationId, { kind: 'adr', title: 'ADR: 通知履歴の保存方式', path: 'docs/adr/0001-notification-history.md',
      purpose: '保存方式の選択を長く参照できるようにする', decision: '通知履歴はDBへ保存する', rationale: 'Humanの返信に基づく検証専用の結論',
      verification: 'ADRに決定と理由が記載されていること' }),
    await reflect('workspace', workspaceIds.consultationId, { kind: 'specification', title: '仕様: Workspaceの優先順位', path: 'docs/specs/workspace-priority.md',
      purpose: '優先順位を仕様として参照できるようにする', decision: 'Project Aを優先する', rationale: 'Humanの返信に基づく検証専用の結論',
      verification: '仕様に優先順位が記載されていること' }),
  ];
  return { repository: { id: repository.id, name: repository.name, url: repository.url, bareRepositoryPath: bare, checkoutPath: checkout },
    consultations: reflected };
};
// Project/Workspace Consultations left at each visible stage (Human待ち・応答中・再開・継続確認待ち・方針訂正) with waiting Tasks.
// Agent steps use the policy-checked public MCP and Human steps the owner's Human use cases. Expected rejections are recorded,
// not asserted, so the Manager can compare them with the current product behavior.
const prepareConsultationLifecycle = async (services, owner, client, entry, inspectRuntime, hiddenWorkspaceId) => {
  const [projectA] = entry.projects.map(({ id }) => id);
  const workspaceId = entry.workspaceId;
  const observations = [];
  const rejected = async (label, expected, role, name, args) => {
    try {
      await client.call(role, name, args);
      observations.push({ label, tool: name, principal: identities[role], expected, observed: 'succeeded', matched: false });
    } catch (error) {
      if (!(error instanceof PreviewOperationError) || error.kind === 'policy_denied' || error.kind === 'tool_unavailable') throw error;
      const observed = error.conflict ?? error.code ?? error.kind;
      observations.push({ label, tool: name, principal: identities[role], expected, observed, matched: observed === expected });
    }
  };
  const same = (label, first, second) => observations.push({ label, expected: 'same result', observed: JSON.stringify(first) === JSON.stringify(second) ? 'same result' : 'different result',
    matched: JSON.stringify(first) === JSON.stringify(second) });
  // Saved artifacts live in a separate checkout of the inspected SHA inside the dedicated directory.
  const runtimeFor = async (name) => {
    const worktreePath = join(data, `consultation-runtime-${name}`);
    execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, worktreePath]);
    execFileSync('git', ['checkout', '-q', '--detach', headSha], { cwd: worktreePath });
    await mkdir(join(worktreePath, '.compass-ralph'));
    const contextPath = join(worktreePath, '.compass-ralph/previous-context.json');
    await writeFile(contextPath, JSON.stringify({ reason: 'Consultation pending', name }));
    await writeFile(join(worktreePath, 'preview-artifact.txt'), `uncommitted artifact ${name}\n`);
    return { worktreePath, read: () => inspectRuntime({ worktreePath, contextPath, pullRequest: null, verificationRefs: [] }) };
  };
  const consultation = (title, question, extra = {}) => ({ title: `[検証専用] ${title}`, question, blockingReason: '既存方針で決められない選択',
    options: [{ label: 'A案' }, { label: 'B案' }], recommendation: 'A案', impact: '専用プレビューの検証データのみ', ...extra });
  const humanReply = async (consultationId, body, requestId = key('reply')) => {
    const reply = await services.human.replyConsultation.execute(owner, projectA, consultationId, { body, requestId });
    client.observe({ projectId: projectA }, reply);
    return reply;
  };
  const waitingTask = async (name, title, consultationIds) => {
    const task = await client.call('manager', 'issue_task', { projectId: projectA, title: `[検証専用] ${title}`, description: '相談待ちから再開する検証専用Task' });
    const claim = await client.call('worker', 'claim_task', { taskId: task.id });
    const runtime = await runtimeFor(name);
    const input = { taskId: task.id, claimId: claim.claimId, consultationIds, reason: '相談の結論待ち', runtime: runtime.read(), requestId: key('wait') };
    const waited = await client.call('worker', 'wait_for_consultation', input);
    return { task, runtime, input, waited };
  };
  const resumptionOf = async (taskId) => (await client.call('worker', 'list_consultation_resumptions', { projectId: projectA }))
    .resumptions.find((item) => item.taskId === taskId);
  const lease = (role, ids, revision) => client.call(role, 'acquire_consultation_lease', { ...ids, inputRevision: revision });

  // Human待ち: 回答不足への追加質問で`waiting_human`へ戻り、Taskは待機を続ける。
  const humanCreated = await client.call('worker', 'create_consultation', { projectId: projectA,
    ...consultation('通知の保存先', '通知履歴をCollaborationとActivityのどちらに保存しますか') });
  const humanIds = { projectId: projectA, consultationId: humanCreated.consultation.id };
  const humanWait = await waitingTask('human', 'Human待ちの相談を待つTask', [humanIds.consultationId]);
  same('wait_for_consultation resent with the same requestId', humanWait.waited, await client.call('worker', 'wait_for_consultation', humanWait.input));
  const candidates = await client.call('worker', 'list_tasks', { projectId: projectA, filter: { availableFor: 'work' } });
  observations.push({ label: 'waiting Task is excluded from work candidates', expected: 'excluded',
    observed: candidates.tasks.some(({ id }) => id === humanWait.task.id) ? 'listed' : 'excluded', matched: !candidates.tasks.some(({ id }) => id === humanWait.task.id) });
  await rejected('direct claim of a waiting Task', 'TASK_NOT_CLAIMABLE', 'worker', 'claim_task', { taskId: humanWait.task.id });
  const replyRequestId = key('reply');
  const firstReply = await humanReply(humanIds.consultationId, 'まだ決めきれません。Activityにすると何が困りますか。', replyRequestId);
  same('Human reply resent with the same requestId', firstReply.message.id,
    (await services.human.replyConsultation.execute(owner, projectA, humanIds.consultationId, { body: 'まだ決めきれません。Activityにすると何が困りますか。', requestId: replyRequestId })).message.id);
  try {
    await services.human.replyConsultation.execute({ kind: 'human', humanUserId: entry.viewerHumanUserId }, projectA, humanIds.consultationId, { body: 'viewer', requestId: key('reply') });
    observations.push({ label: 'viewer reply', expected: 'rejected', observed: 'succeeded', matched: false });
  } catch (error) {
    observations.push({ label: 'viewer reply', expected: 'rejected', observed: `rejected: ${error.code ?? error.name}`, matched: true });
  }
  const questionLease = await lease('manager', humanIds, firstReply.consultation.revision);
  await rejected('lease on the same revision by another Principal', 'LEASE_HELD', 'reviewer', 'acquire_consultation_lease', { ...humanIds, inputRevision: firstReply.consultation.revision });
  await client.call('manager', 'reply_consultation', { ...humanIds, leaseId: questionLease.lease.id, expectedRevision: firstReply.consultation.revision,
    body: 'Activityは履歴でありworkflowの状態を持たないため、未処理の通知を追えません。Collaborationでよいですか。' });

  // 応答中: Humanの返信にManagerが応答leaseを持つ。応答中の追加返信で古い版の結論は拒否され、新しい版のleaseを残す。
  const respondingCreated = await client.call('worker', 'create_consultation', { projectId: projectA,
    ...consultation('公開APIの範囲', '管理APIをMCPへ公開しますか') });
  const respondingIds = { projectId: projectA, consultationId: respondingCreated.consultation.id };
  await waitingTask('responding', '応答中の相談を待つTask', [respondingIds.consultationId]);
  const respondingReply = await humanReply(respondingIds.consultationId, 'A案で進めてください。');
  const staleLease = await lease('manager', respondingIds, respondingReply.consultation.revision);
  const addedReply = await humanReply(respondingIds.consultationId, '補足: 既存の管理画面は変えないでください。');
  await rejected('conclusion on a revision older than an added Human reply', 'STALE_REVISION', 'manager', 'resolve_consultation', { ...respondingIds,
    leaseId: staleLease.lease.id, expectedRevision: respondingReply.consultation.revision, conclusion: 'A案', rationale: '古い版', basisMessageIds: [respondingReply.message.id] });
  const heldLease = await lease('manager', respondingIds, addedReply.consultation.revision);

  // 再開: 結論（agent_summary）→ ready → 元のwork段階の新Claim。成果物は別checkoutに保持される。
  const resumedCreated = await client.call('worker', 'create_consultation', { projectId: projectA,
    ...consultation('通知テーブルの扱い', '既存の通知テーブルを使いますか') });
  const resumedIds = { projectId: projectA, consultationId: resumedCreated.consultation.id };
  const resumedWait = await waitingTask('resumed', '結論の後に再開したTask', [resumedIds.consultationId]);
  const resumedReply = await humanReply(resumedIds.consultationId, 'B案（既存の通知テーブルは使わない）にしてください。');
  const resolveLease = await lease('manager', resumedIds, resumedReply.consultation.revision);
  const resolveInput = { ...resumedIds, leaseId: resolveLease.lease.id, expectedRevision: resumedReply.consultation.revision,
    conclusion: '既存の通知テーブルは使わない', rationale: 'HumanがB案を選んだ', basisMessageIds: [resumedReply.message.id], requestId: key('resolve') };
  same('resolve_consultation resent with the same requestId', await client.call('manager', 'resolve_consultation', resolveInput),
    await client.call('manager', 'resolve_consultation', resolveInput));
  const ready = await resumptionOf(resumedWait.task.id);
  observations.push({ label: 'resumption after the conclusion', expected: 'ready', observed: ready?.state ?? 'missing', matched: ready?.state === 'ready' });
  const resumeInput = { taskId: resumedWait.task.id, runtime: resumedWait.runtime.read(), requestId: key('resume') };
  const resumed = await client.call('worker', 'resume_consultation_task', resumeInput);
  same('resume_consultation_task resent with the same requestId', resumed, await client.call('worker', 'resume_consultation_task', resumeInput));
  await rejected('second resumption request', 'CLAIM_CONFLICT', 'worker', 'resume_consultation_task', { taskId: resumedWait.task.id, runtime: resumedWait.runtime.read() });

  // 継続確認待ち: 2件を待つTaskで、1件はHumanの明示決定、1件はManagerの取消。Managerの継続確認までreadyにしない。
  const decidedCreated = await client.call('worker', 'create_consultation', { projectId: projectA, ...consultation('旧画面の扱い', '旧画面を残しますか') });
  const canceledCreated = await client.call('worker', 'create_consultation', { projectId: projectA, ...consultation('旧APIの扱い', '旧APIを残しますか') });
  const decidedIds = { projectId: projectA, consultationId: decidedCreated.consultation.id };
  const canceledIds = { projectId: projectA, consultationId: canceledCreated.consultation.id };
  const multiWait = await waitingTask('confirmation', '複数の相談と取消を待つTask', [decidedIds.consultationId, canceledIds.consultationId]);
  const decided = await services.human.decideConsultation.execute(owner, projectA, decidedIds.consultationId, { conclusion: '旧画面は削除する',
    rationale: 'Humanの明示決定（検証専用）', selectedOption: 0, expectedRevision: decidedCreated.consultation.revision, requestId: key('decide') });
  client.observe({ projectId: projectA }, decided);
  await client.call('manager', 'cancel_consultation', { ...canceledIds, reason: '別Storyで旧APIを削除済みのため不要', expectedRevision: canceledCreated.consultation.revision });
  const confirmation = await resumptionOf(multiWait.task.id);
  observations.push({ label: 'resumption after a Human decision and a cancellation', expected: 'waiting', observed: confirmation?.state ?? 'missing',
    matched: confirmation?.state === 'waiting', failureReason: confirmation?.failureReason ?? null });
  await rejected('continuation confirmed by a Worker', 'FORBIDDEN', 'worker', 'confirm_consultation_continuation', { taskId: multiWait.task.id,
    expectedRequirementVersion: confirmation.requirementVersion, consultationRevisions: confirmation.consultations.map(({ id, revision }) => ({ id, revision })), reason: 'Workerによる確認' });

  // 方針訂正: 解決済みの相談を参照する新しい相談。Workspace相談はHuman待ちのまま残す。viewerが所属しないWorkspaceの相談はviewerに見えない。
  const correction = await client.call('manager', 'create_consultation', { projectId: projectA, ...consultation('通知テーブルの方針訂正',
    '保存期間の要件が追加されたため、通知テーブルを使わない方針を見直しますか', { supersedesConsultationId: resumedIds.consultationId }) });
  const workspaceWaiting = await client.call('strategist', 'create_consultation', { workspaceId,
    ...consultation('次に優先するOutcome', '検索改善と通知改善のどちらを先に追いますか') });
  const hidden = await client.call('strategist', 'create_consultation', { workspaceId: hiddenWorkspaceId,
    ...consultation('未所属Workspaceの判断', 'viewerが所属しないWorkspaceの非公開の判断') });

  const projectPath = (consultationId) => `/projects/${projectA}/consultations/${consultationId}`;
  return {
    stages: [
      { stage: 'waiting_human', consultationId: humanIds.consultationId, taskId: humanWait.task.id, expected: 'Human待ち・追加質問・Task waiting', path: projectPath(humanIds.consultationId) },
      { stage: 'agent_responding', consultationId: respondingIds.consultationId, expected: 'Agent応答中（manager lease）', leaseExpiresAt: heldLease.lease.expiresAt,
        path: projectPath(respondingIds.consultationId) },
      { stage: 'resumed', consultationId: resumedIds.consultationId, taskId: resumedWait.task.id, claimId: resumed.claimId ?? resumed.claim?.claimId ?? null,
        expected: '結論（agent_summary）・元のwork段階で再開', path: projectPath(resumedIds.consultationId), taskPath: `/projects/${projectA}/tasks/${resumedWait.task.id}`,
        artifactPath: join(resumedWait.runtime.worktreePath, 'preview-artifact.txt') },
      { stage: 'confirmation_required', consultationIds: [decidedIds.consultationId, canceledIds.consultationId], taskId: multiWait.task.id,
        expected: 'Humanの明示決定と取消・Managerの継続確認待ち', paths: [projectPath(decidedIds.consultationId), projectPath(canceledIds.consultationId)] },
      { stage: 'correction', consultationId: correction.consultation.id, supersedes: resumedIds.consultationId, path: projectPath(correction.consultation.id) },
      { stage: 'workspace_waiting_human', consultationId: workspaceWaiting.consultation.id, path: `/workspaces/${workspaceId}/consultations/${workspaceWaiting.consultation.id}` },
      { stage: 'hidden_from_viewer', workspaceId: hiddenWorkspaceId, consultationId: hidden.consultation.id, path: `/workspaces/${hiddenWorkspaceId}/consultations/${hidden.consultation.id}` },
    ],
    observations,
  };
};
// Web API responses before the preview server starts on the same DB file; the preview is the restarted server.

// Release history: accepted Tasks with deliverable commits, a loopback GitHub (commit existence and ancestry only) and
// publication records sent through the public Web API with a dedicated Project Runtime Credential (`publication:write`).
// Published (included), unpublished (not included) and unconfirmed (history not comparable) all come from recorded observations.
const releaseCommit = (index) => index.toString(16).padStart(40, '0');
const releaseHistoryShas = [];
const releaseGithub = createServer((request, response) => {
  const url = new URL(request.url ?? '', 'http://localhost');
  const send = (status, body) => response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  let match = /^\/repos\/preview-org\/release-demo\/commits\/([a-f0-9]{40})$/.exec(url.pathname);
  if (match) return releaseHistoryShas.includes(match[1]) ? send(200, { sha: match[1] }) : send(422, { message: 'No commit found' });
  match = /^\/repos\/preview-org\/release-demo\/compare\/([a-f0-9]{40})\.\.\.([a-f0-9]{40})$/.exec(url.pathname);
  if (match) {
    const [base, head] = [releaseHistoryShas.indexOf(match[1]), releaseHistoryShas.indexOf(match[2])];
    return base < 0 || head < 0 ? send(404, { message: 'Not Found' }) : send(200, { status: base === head ? 'identical' : base < head ? 'ahead' : 'behind' });
  }
  return send(404, { message: 'Not Found' });
});
await new Promise((resolveListen) => releaseGithub.listen(0, '127.0.0.1', resolveListen));
const releaseApiBaseUrl = `http://127.0.0.1:${releaseGithub.address().port}`;
const releaseCounts = { published: 12, notPublished: 10, unconfirmed: 2 };
const prepareReleaseHistory = async (services, owner, app) => {
  const work = services.taskCoordinationService;
  const workspace = await services.human.createWorkspace.execute({ name: '[受入] リリース履歴', mission: '開発の受入と公開の確認を別の根拠で辿る' }, owner);
  const intent = await services.workspaceDirection.createIntentUseCase.execute(workspace.id, { title: 'リリース履歴 Intent', desiredState: '変更が公開されたかを根拠から確認できる' });
  const outcome = await services.workspaceDirection.createOutcomeUseCase.execute(workspace.id, intent.id, {
    title: 'リリース履歴 Outcome', intentVersion: 1, description: '公開状況の表示検証専用。実運用の成果ではない。', rationale: '画面受入の前提データ',
    successCriteria: [{ description: '公開済み・未公開・確認できずを区別できる', measurement: '公開記録と画面を照合する', target: '捏造なし' }] });
  const project = await services.human.createWorkspaceProject.execute(owner, workspace.id, { name: '[受入] リリース履歴 Project',
    repositories: [{ name: 'release-demo', url: 'https://github.com/preview-org/release-demo' }] });
  for (const role of ['manager', 'worker', 'reviewer']) await services.grantProjectRoleUseCase.execute(project.id, { principalId: identities[role], role });
  await services.workspaceDirection.setOutcomeTargetProjectUseCase.execute(workspace.id, outcome.id, project.id);
  const repository = project.repositories[0];
  const total = releaseCounts.published + releaseCounts.notPublished + releaseCounts.unconfirmed;
  const story = await work.issueStory(identities.manager, { projectId: project.id, outcomeId: outcome.id, title: 'リリース履歴の確認用Story' }, key('story'));
  const tasks = [];
  for (let index = 1; index <= total; index += 1) {
    const task = await work.issueTask(identities.manager, { projectId: project.id, storyId: story.id, taskKey: `release-${index}`, title: `リリース変更 ${index}` }, key('task'));
    const claim = await work.claimTask(identities.worker, task.id, key('claim'));
    await work.addTaskComment(identities.worker, task.id, claim.claimId, `リリース変更 ${index} の実装メモ: src/change-${index}.ts を追加し、題名にない確認手順を記録した。画面検証専用の決定的fixtureで、実Agentの成果ではない。`, key('comment'));
    await work.completeTask(identities.worker, task.id, claim.claimId, key('complete'));
    const review = await work.claimReview(identities.reviewer, task.id, key('review'));
    await work.reviewedTask(identities.reviewer, task.id, review.claimId, key('reviewed'));
    const acceptance = await work.claimAcceptance(identities.manager, task.id, key('acceptance'));
    await work.acceptTask(identities.manager, task.id, acceptance.claimId, key('accept'),
      [{ repositoryId: repository.id, commitSha: releaseCommit(index), paths: [`src/change-${index}.ts`], pullRequestUrl: null }]);
    tasks.push({ index, taskId: task.id, commitSha: releaseCommit(index) });
  }
  // The loopback history knows the first (published + unpublished) commits; the last ones are unknown to it (not comparable).
  const comparable = releaseCounts.published + releaseCounts.notPublished;
  for (let index = 1; index <= comparable; index += 1) releaseHistoryShas.push(releaseCommit(index));
  const origin = 'http://localhost';
  const signedIn = await app.request(`${origin}/auth/local/login`, { method: 'POST', redirect: 'manual', headers: { Origin: origin }, body: new URLSearchParams({ email: ownerEmail }) });
  const cookie = signedIn.headers.get('set-cookie')?.match(/compass_session=[^;]+/)?.[0];
  if (!cookie) throw new Error('Preview owner could not sign in for release preparation');
  const issued = await app.request(`${origin}/api/projects/${project.id}/credentials`, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: origin, 'X-Compass-CSRF': deriveCsrfToken(cookie.split('=')[1]) },
    body: JSON.stringify({ kind: 'runtime', principalId: 'preview-deployer', scopes: ['publication:write'] }) });
  if (issued.status !== 201) throw new Error(`Runtime credential could not be issued: ${issued.status} ${await issued.text()}`);
  const { token } = await issued.json();
  const publish = async (revision, observedAt) => {
    const response = await app.request(`${origin}/api/projects/${project.id}/publications`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ repositoryId: repository.id, revision, target: 'production', targetUrl: 'https://release-demo.example.test', method: 'preview-fixture', observedAt,
        evidence: [{ kind: 'deployment', uri: 'https://example.test/fixtures/release-demo/deployments/1' }] }) });
    if (response.status !== 201 && response.status !== 200) throw new Error(`Publication could not be recorded: ${response.status}`);
    return (await response.json()).publication.id;
  };
  // The production deployment contains the first commits only; later accepted commits are not included (unpublished).
  const publicationId = await publish(releaseCommit(releaseCounts.published), Date.now() - 60_000);
  return { projectId: project.id, workspaceId: workspace.id, intentId: intent.id, outcomeId: outcome.id, repositoryId: repository.id, publicationId, counts: releaseCounts,
    apiPath: `/projects/${project.id}/releases`, screenPath: `/projects/${project.id}?view=releases`, tasks,
    expected: { published: tasks.slice(0, releaseCounts.published).map(({ taskId }) => taskId),
      notPublished: tasks.slice(releaseCounts.published, comparable).map(({ taskId }) => taskId),
      unconfirmed: tasks.slice(comparable).map(({ taskId }) => taskId) },
    note: '公開記録はRuntime Credential（publication:write）の公開APIで追加した。公開済みはHEAD履歴に含まれる変更、未公開は含まれない変更、確認できずは履歴を比較できない変更。効果の評価ではない。' };
};
const persistenceSnapshot = async (app, entries) => {
  const origin = 'http://localhost';
  const signedIn = await app.request(`${origin}/auth/local/login`, { method: 'POST', redirect: 'manual', headers: { Origin: origin },
    body: new URLSearchParams({ email: ownerEmail }) });
  const cookie = signedIn.headers.get('set-cookie')?.match(/compass_session=[^;]+/)?.[0];
  if (!cookie) throw new Error('Preview owner could not sign in for the persistence snapshot');
  const responses = {};
  for (const path of ['/api/consultations?status=all', ...entries.flatMap(({ path, paths }) => paths ?? (path ? [path] : [])).map((path) => `/api${path}`)]) {
    const response = await app.request(origin + path, { headers: { Cookie: cookie } });
    responses[path] = { status: response.status, body: await response.json() };
  }
  return responses;
};
let observedTools = [];
let releaseHistory;
let preparation;
let persistence;
try {
  await initializeSchema(database);
  const releaseGithubGateway = new GitHubPullRequestGateway({ apiBaseUrl: releaseApiBaseUrl });
  const services = createApplicationServices(database, undefined, undefined, { initialOwnerEmail: ownerEmail },
    { pullRequests: releaseGithubGateway, revisions: releaseGithubGateway });
  const login = await services.localDevLoginUseCase.execute({ email: ownerEmail, previousSessionToken: null });
  if (login.kind !== 'logged_in') throw new Error('Preview owner could not be registered');
  const owner = { kind: 'human', humanUserId: login.session.humanUserId };
  const direction = services.workspaceDirection;
  const work = services.taskCoordinationService;
  const { createApp } = await targetModule('server/src/bootstrap/app.ts');
  const app = createApp(services, { humanAuth: { mode: 'trusted-local', publicOrigin: 'http://localhost' } });
  // 招待の受諾で所属WorkspaceのMembership（配下のすべてのProjectに同じRole）になる（ADR 0003）。
  const addViewer = async (workspaceId, projectId) => {
    const invitation = await services.createProjectInvitationUseCase.execute(owner, projectId, { email: viewerEmail, role: 'viewer' });
    const signedIn = await services.localDevLoginUseCase.execute({ email: viewerEmail, invitationToken: invitation.token, previousSessionToken: null });
    if (signedIn.kind !== 'logged_in') throw new Error('Preview viewer invitation could not be accepted');
    const humanUserId = signedIn.session.humanUserId;
    const members = await services.human.listWorkspaceMembers.execute(owner, workspaceId);
    if (!members.some(({ human }) => human.id === humanUserId)) throw new Error('Preview viewer did not join the Workspace');
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
      title: `${name} Outcome`, description: 'Managerの表示・参照検証専用。実運用の成果ではない。', intentVersion: 1, rationale: '画面受入の前提データ',
      successCriteria: [
        { description: 'Target別のStoryとEvidenceを参照できる', measurement: 'Project別の保存データと画面リンクを照合する', target: '全Target' },
        { description: '権限に応じてWorkと編集導線が制限される', measurement: 'ownerとviewerで実API・実画面を比較する', target: '越権なし' },
      ],
      problems: [
        { statement: '[検証用] 登録手順の途中で離脱する', evidenceStatus: 'insufficient', solutionHypothesis: '入力項目を減らす',
          evaluationPlan: { question: '入力を減らすと完了率は上がるか', method: 'ab_test', premises: '利用者を無作為に2群へ割り付けられる', observationPeriod: '公開後2週間', decisionCriteria: '完了率が5pt以上高い', stopCriteria: '離脱が悪化したら中止' } },
        { statement: '[検証用] 初回の操作が分かりにくい', evidenceStatus: 'insufficient', solutionHypothesis: '案内文を短くする',
          evaluationPlan: { question: '案内文を短くすると迷わず操作できるか', method: 'cognitive_walkthrough', decisionCriteria: '手順の各段階で次の操作が分かる' } },
        { statement: '[検証用] 公開後の継続利用が増えない', evidenceStatus: 'insufficient', solutionHypothesis: '通知の頻度を調整する',
          evaluationPlan: { question: '通知を調整すると継続利用は増えるか', method: 'quantitative_observation', observationPeriod: '公開後4週間', decisionCriteria: '週次の継続利用率が上がる' } },
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
    if (scenario === 'partial-work') {
      // No explanation yet: one goal whose Metric is defined but unmeasured, and one goal without any Metric. Neither is filled in.
      await services.defineIntentMetricUseCase.execute(identities.strategist, workspace.id, intent.id,
        { key: 'completion_rate', name: '登録完了率', unit: '%', targetValue: null, staleAfterDays: 7 });
      const bare = await direction.createIntentUseCase.execute(workspace.id, { title: `${name} 観測項目なしの目標`, desiredState: '観測項目が未定義の状態を確認する' });
      entry.intentExplanationStates = [
        { state: 'metric_unmeasured_no_explanation', path: `/projects/${entry.projects[0].id}/intents/${intent.id}` },
        { state: 'no_metric_no_explanation', path: `/projects/${entry.projects[0].id}/intents/${bare.id}` },
      ];
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
      await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, identities.evaluator, outcome.id, { requestKey: key('evaluation-insufficient'), runRef: 'browser-preview-fixture',
        method: 'cognitive_walkthrough', targetVersion: 'browser-preview-fixture', limitations: '設計の点検のみ。実ユーザーは観測していない。', problemIds: [outcome.problems[1].id], planIds: planIdsOf(outcome, [1]),
        criteria: outcome.successCriteria.map((criterion) => ({ criterionId: criterion.id, verdict: 'insufficient_evidence', rationale: '実ユーザーの観測が無く判断できない', evidenceIds: [] })) });
      const saved = await direction.recordOutcomeEvaluationUseCase.execute(workspace.id, identities.evaluator, outcome.id, { requestKey: key('evaluation'), runRef: 'browser-preview-fixture', method: 'quantitative_observation', targetVersion: 'browser-preview-fixture', limitations: '専用fixtureの保存済み参照だけを根拠にした表示確認', problemIds: [outcome.problems[0].id], planIds: planIdsOf(outcome, [0]),
        criteria: outcome.successCriteria.map((criterion, index) => ({ criterionId: criterion.id, verdict: index === 0 ? 'met' : 'not_met',
          rationale: index === 0 ? '専用fixtureの保存済み参照' : '比較表示用の未充足判定。製品の不具合判定ではない。', evidenceIds })) });
      const decision = await direction.createDirectionDecisionUseCase.execute(workspace.id, identities.strategist, { intentId: intent.id, evaluationId: saved.evaluation.id,
        type: 'additional_research', intentVersion: 1, judgment: '権限差の検証条件を追加調査する', reason: '画面上でEvaluationとDecisionの関連を確認するfixture',
        requestKey: key('decision'), runRef: 'browser-preview-fixture', usedSyntheses: [{ synthesisId: synthesis.id, version: synthesis.version }],
        research: { question: 'viewerの見え方を比較する', scope: '専用プレビューのみ', completionCondition: 'アクセス制御を独立に検証できる', budgetTotal: 10 } });
      Object.assign(entry, { researchRequestId: request.id, evaluationId: saved.evaluation.id, decisionId: decision.decision.id,
        expectedVerdicts: ['met', 'not_met'] });
      // The goal detail shows the Agent explanations (facts / hypotheses / proposals) with resolved basis, an outdated basis and a previous version.
      const intentProject = entry.projects[0];
      entry.intentExplanations = { ...await prepareIntentExplanations(services, workspace.id, intentProject.id, intent, outcome,
        { findingId: result.findings[0].id, synthesisId: synthesis.id, decisionId: decision.decision.id, evaluationId: saved.evaluation.id }),
        path: `/projects/${intentProject.id}/intents/${intent.id}`, expected: 'completion_rate: v2 (previous v1 whose basis was corrected) and weekly_retention v1; all with kind-separated items' };
    }
    scenarios.push(entry);
  }
  releaseHistory = await prepareReleaseHistory(services, owner, app);
  preparation = { endpointPath: '/mcp', actors: identities,
    projectIds: [...scenarios.flatMap(({ projects }) => projects.map(({ id }) => id)), releaseHistory.projectId],
    workspaceIds: [...scenarios.map(({ workspaceId }) => workspaceId), releaseHistory.workspaceId], operationPolicy: previewOperationPolicy };
  // Read the inspected revision's public MCP contract; permission comes from the policy, not from listed names.
  const client = createPreviewMcpClient({ origin: 'http://localhost', preparation, fetch: (url, init) => app.request(url, init) });
  observedTools = (await client.listTools('manager')).map(classifyTool);
  const evaluated = scenarios.find(({ scenario }) => scenario === 'evaluated');
  try {
    evaluated.consultationReflection = { status: 'prepared', ...await prepareReflections(services, owner, client, evaluated) };
  } catch (error) {
    // An inspected SHA without the public reflection contract is recorded, never patched with internal operations.
    if (!(error instanceof PreviewOperationError) || !['tool_unavailable', 'policy_denied'].includes(error.kind)) throw error;
    evaluated.consultationReflection = { status: 'unavailable', kind: error.kind, tool: error.tool, message: error.message };
  }
  const partial = scenarios.find(({ scenario }) => scenario === 'partial-work');
  try {
    const { inspectConsultationRuntime } = await targetModule('ralph/runtime/consultation-context.mjs');
    const hiddenWorkspaceId = scenarios.find(({ scenario }) => scenario === 'no-target').workspaceId;
    partial.consultationLifecycle = { status: 'prepared', ...await prepareConsultationLifecycle(services, owner, client, partial, inspectConsultationRuntime, hiddenWorkspaceId) };
  } catch (error) {
    if (!(error instanceof PreviewOperationError) || !['tool_unavailable', 'policy_denied'].includes(error.kind)) throw error;
    partial.consultationLifecycle = { status: 'unavailable', kind: error.kind, tool: error.tool, message: error.message };
  }
  persistence = { takenAt: new Date().toISOString(), responses: await persistenceSnapshot(app, [
    ...(partial.consultationLifecycle.stages ?? []), ...(evaluated.consultationReflection.consultations ?? []), { path: releaseHistory.apiPath }]) };
} finally {
  await database.destroy();
  await new Promise((resolveClose) => releaseGithub.close(resolveClose));
}
const scriptSha256 = createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const manifest = { schemaVersion: 1, purpose: 'browser-verification-fixtures', headSha, preparationScriptSha256: scriptSha256,
  repositoryRoot: root, databasePath, createdAt: new Date().toISOString(),
  dataPreparation: {
    policyPath: resolve(dirname(fileURLToPath(import.meta.url)), '../docs/browser-verification.md'),
    scope: 'isolated-preview-only', ...preparation,
    // Observation of the inspected contract at preparation time. It is not a permission list; re-read tools/list before calling.
    observedTools,
    consultationResumptionEnabled: ['wait_for_consultation', 'list_consultation_resumptions', 'resume_consultation_task',
      'confirm_consultation_continuation'].every((name) => observedTools.some((tool) => tool.name === name && tool.context === 'work')),
    runtimeArtifacts: {
      scope: 'dedicated-verification-directory-only',
      instructions: 'Save a separate temporary Git checkout at this headSha, uncommitted artifacts and previous Context. Use the inspected revision runtime/consultation-context.mjs. Do not use or modify the actual acceptance execution Worktree/Context.',
    },
    claimTtlMs: Number(process.env.COMPASS_CLAIM_TTL_MS ?? 30 * 60 * 1000),
    instructions: 'Read policyPath. Use only the dedicated preview URL and these preview actors. Any current tool classified by operationPolicy is permitted within projectIds/workspaceIds; execution Task/Claim, operational MCP and Human management tools are outside this permission.',
  },
  login: { mode: 'trusted-local', ownerEmail, viewerEmail, instructions: 'ログイン画面からemailを入力する。viewerは[受入] 一部Project未着手・[受入] 複数Targetと評価根拠のWorkspaceのviewer（配下のProject A・Bとも同じRole）で、[受入] TargetなしのWorkspaceは未所属。' },
  releaseHistory, scenarios, limitations: ['データ準備は公開APIによる管理操作のAC検証ではない', '判定・Evidenceは表示確認用fixtureであり、実Agentの自律運転や実成果を示さない'] };
const manifestPath = join(data, 'browser-fixtures.json');
// The preview server reopens this DB file, so comparing its Web API responses with this snapshot checks a same-DB restart.
const persistencePath = join(data, 'persistence-before-restart.json');
await writeFile(persistencePath, JSON.stringify(persistence, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
manifest.persistenceCheck = { snapshotPath: persistencePath, takenAt: persistence.takenAt, paths: Object.keys(persistence.responses),
  instructions: 'After the preview starts on the same DB file, GET each path as the owner and compare status and body. Responder leases, Claim expiry and resumption states change only with time or a reconciliation.' };
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ manifestPath, headSha, dataPreparation: manifest.dataPreparation,
  scenarios: scenarios.map(({ scenario, workspaceId, outcomeId }) => ({ scenario, workspaceId, outcomeId })) }));
