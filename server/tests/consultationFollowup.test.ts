import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/bootstrap/app.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { addTestMembership, createTestHuman, requestAs, seedWorkspaceGrant, type TestHuman } from "./support/humanSession.ts";

/**
 * 相談の結論から文書反映（仕様・Policy・ADR）へ。反映担当ProjectのManagerが公開MCPで結論から文書反映Taskを依頼し、通常の
 * Worker→Reviewer→Managerで受け入れる。Managerは受入時に検証用Repositoryへの実際のcommit（path・commit SHA・PR URL）を受入成果物として残し、
 * 相談へはそれと一致する参照だけを登録できる。同じ依頼・参照の再送で二重作成しないこと、未受入・無関係なTask・別Repository・受入証跡に無い
 * path / commit / PR・別scopeの参照で反映済みにしないこと、元Taskは明示的な依存がなければ結論だけで再開できること、Workspace相談の結論も
 * 所属Projectのmanagerが引き継げ、所属しないProject・権限の無いRoleでは引き継げないことを確認する。
 */

type App = ReturnType<typeof createApp>;
type ToolResult = { isError?: boolean; structuredContent: Record<string, any> };

const clock = { now: 1_800_000_000_000 };

const open = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, () => clock.now);
  return { database, services, app: createApp(services) };
};
type Kit = Awaited<ReturnType<typeof open>>;

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
  return result.structuredContent.error as { code: string; conflict?: string };
};
const json = async (response: Response) => (await response.json()) as Record<string, any>;
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

let counter = 0;
const next = (label: string) => `${label}-${++counter}`;

/** 公開操作のGiven。ownerがWeb APIでRepository付きのProjectを作り、別PrincipalのWorker / Reviewer / Manager Grantを付与する。 */
const seed = async (kit: Kit, name = "Compass") => {
  const owner = await createTestHuman(kit.database);
  const asOwner = requestAs(kit.app, owner);
  const created = await json(await asOwner("/api/projects", post({
    name,
    mission: "Decisions reach the documents",
    repositories: [
      { name: "docs", url: "https://example.com/compass-docs.git" },
      { name: "app", url: "https://example.com/compass-app.git" },
    ],
  })));
  const project = created.project as { id: string; workspaceId: string; repositories: { id: string; name: string }[] };
  for (const [principalId, role] of [["manager-a", "manager"], ["worker-a", "worker"], ["reviewer-a", "reviewer"], ["worker-b", "worker"]]) {
    assert.equal((await asOwner(`/api/projects/${project.id}/grants`, post({ principalId, role }))).status, 201);
  }
  const humans: Record<"owner" | "editor" | "viewer", TestHuman> = { owner, editor: await createTestHuman(kit.database), viewer: await createTestHuman(kit.database) };
  await addTestMembership(kit.database, project.id, humans.editor, "editor");
  await addTestMembership(kit.database, project.id, humans.viewer, "viewer");
  const [docs, app] = project.repositories;
  return { project, docs: docs!, appRepository: app!, as: (who: keyof typeof humans) => requestAs(kit.app, humans[who]) };
};
type Seeded = Awaited<ReturnType<typeof seed>>;

const runtime = { worktreePath: "/tmp/saved-worktree", contextPath: "/tmp/saved-context.json", headSha: "a".repeat(40), sourceFingerprint: "dirty", pullRequest: null, verificationRefs: [] };

/** Workerが作業中のTaskで設計相談を作り、Taskを相談待ちにする。editorが返信し、Managerが会話から結論を整理する。 */
const resolveDesignConsultation = async (kit: Kit, seeded: Seeded) => {
  const { project, as } = seeded;
  const task = ok(await callTool(kit.app, "issue_task", { projectId: project.id, title: "認証基盤を実装する", requestId: next("task") }, "worker-a", "worker"));
  const claim = ok(await callTool(kit.app, "claim_task", { taskId: task.id, requestId: next("claim") }, "worker-a", "worker"));
  const created = ok(await callTool(kit.app, "create_consultation", {
    projectId: project.id,
    title: "Session保存方式",
    question: "SessionをDBに保存するかJWTにするかを決めてください",
    blockingReason: "認証基盤の構造がこの選択で分岐する",
    options: [{ label: "DB Session" }, { label: "JWT" }],
    recommendation: "DB Session。失効を即時に反映できる",
    impact: "認証・失効・監査の実装",
    refs: [{ kind: "task", id: task.id }],
    requestId: next("create"),
  }, "worker-a", "worker"));
  const consultationId = created.consultation.id as string;
  ok(await callTool(kit.app, "wait_for_consultation", { taskId: task.id, claimId: claim.claimId, consultationIds: [consultationId], reason: "構造の判断が必要", runtime, requestId: next("wait") }, "worker-a", "worker"));
  const reply = await json(await as("editor")(`/api/projects/${project.id}/consultations/${consultationId}/messages`, post({ body: "DB Sessionで進めてください", requestId: next("reply") })));
  const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { projectId: project.id, consultationId, inputRevision: reply.consultation.revision, requestId: next("lease") }, "manager-a", "manager"));
  ok(await callTool(kit.app, "resolve_consultation", {
    projectId: project.id, consultationId, leaseId: lease.lease.id, expectedRevision: reply.consultation.revision,
    conclusion: "SessionはDBに保存する", rationale: "Humanの回答と即時失効の要件", basisMessageIds: [reply.message.id], requestId: next("resolve"),
  }, "manager-a", "manager"));
  return { task, consultationId };
};

const followupInput = (seeded: { project: { id: string }; docs: { id: string } }, overrides: object = {}) => ({
  projectId: seeded.project.id,
  kind: "adr",
  repositoryId: seeded.docs.id,
  title: "ADR: Sessionの保存方式",
  purpose: "Session保存方式の選択と理由を長く参照できるようにする",
  decision: "SessionはDBに保存する。JWTは採用しない",
  rationale: "即時失効と監査が必要。Humanの回答に基づく",
  verification: "ADRに決定・代替案（JWT）・トレードオフが記載されていること",
  ...overrides,
});

type Deliverable = { repositoryId: string; commitSha: string; paths: string[]; pullRequestUrl: string | null };

/** 文書反映Taskを通常のWorker→Reviewer→Managerで受け入れる。Managerは確認した成果物を受入証跡（`deliverables`）として残す。 */
const acceptThroughWork = async (kit: Kit, taskId: string, deliverables?: Deliverable[], manager = "manager-a", members = { worker: "worker-b", reviewer: "reviewer-a" }) => {
  const work = ok(await callTool(kit.app, "claim_task", { taskId, requestId: next("claim") }, members.worker, "worker"));
  ok(await callTool(kit.app, "add_task_comment", { taskId, claimId: work.claimId, body: "ADRを追加した", requestId: next("comment") }, members.worker, "worker"));
  ok(await callTool(kit.app, "complete_task", { taskId, claimId: work.claimId, requestId: next("complete") }, members.worker, "worker"));
  const review = ok(await callTool(kit.app, "claim_review", { taskId, requestId: next("review") }, members.reviewer, "reviewer"));
  ok(await callTool(kit.app, "reviewed_task", { taskId, claimId: review.claimId, requestId: next("reviewed") }, members.reviewer, "reviewer"));
  const acceptance = ok(await callTool(kit.app, "claim_acceptance", { taskId, requestId: next("acceptance") }, manager, "manager"));
  const accept = { taskId, claimId: acceptance.claimId, ...(deliverables ? { deliverables } : {}) };
  ok(await callTool(kit.app, "accept_task", { ...accept, requestId: next("accept") }, manager, "manager"));
};

const adrPath = "docs/adr/0003-session-storage.md";

/** 検証用Repositoryへ実際にADRを書いてcommitし、完全なcommit SHAを返す。 */
const commitAdr = async (decision: string) => {
  const directory = await mkdtemp(join(tmpdir(), "compass-followup-repo-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.email", "worker@example.com");
  git("config", "user.name", "worker-b");
  await mkdir(join(directory, "docs/adr"), { recursive: true });
  await writeFile(join(directory, "docs/adr/0003-session-storage.md"), `# Sessionの保存方式\n\n## 決定\n\n${decision}\n`);
  git("add", ".");
  git("commit", "-q", "-m", "docs: add ADR for session storage");
  return {
    directory,
    sha: git("rev-parse", "HEAD"),
    show: (path: string) => git("show", `HEAD:${path}`),
    changedPaths: () => git("show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean),
  };
};

test("結論→文書反映Task→通常のReview・受入→実commitの参照登録まで辿れ、元Taskは反映を待たずに再開できる", async () => {
  const kit = await open();
  const repository = await commitAdr("SessionはDBに保存する。JWTは採用しない");
  try {
    const seeded = await seed(kit);
    const { project, docs, appRepository, as } = seeded;
    const { task: original, consultationId } = await resolveDesignConsultation(kit, seeded);

    // Managerが結論からADRの反映を依頼する。通常のWork Taskが同じ操作で起票され、本文に結論ID・目的・決定内容・根拠・検証方法が入る。
    const requested = ok(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded), requestId: next("followup") }, "manager-a", "manager"));
    const followup = requested.followup;
    assert.equal(followup.status, "pending");
    assert.equal(followup.blocksResumption, false);
    assert.equal(followup.repository.id, docs.id);
    const docTask = await json(await as("viewer")(`/api/projects/${project.id}/tasks/${followup.taskId}`));
    assert.equal(docTask.task.status, "todo");
    for (const fragment of [consultationId, followup.resolutionId, "SessionはDBに保存する。JWTは採用しない", "即時失効と監査", "代替案（JWT）", "元Taskの受入を待たない"]) {
      assert.ok(docTask.task.description.includes(fragment), fragment);
    }

    // 同じ結論・反映先への再送（別のrequestId・通信断後の再試行）は同じ依頼・Taskを返し、内容が違えば競合にする。
    const again = ok(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded), requestId: next("followup-retry") }, "manager-a", "manager"));
    assert.equal(again.followup.id, followup.id);
    assert.equal(again.followup.taskId, followup.taskId);
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded, { decision: "JWTにする" }), requestId: next("followup-changed") }, "manager-a", "manager")).conflict, "FOLLOWUP_EXISTS");
    const tasks = ok(await callTool(kit.app, "list_tasks", { projectId: project.id }, "manager-a", "manager"));
    assert.equal(tasks.tasks.filter((task: { title: string }) => task.title === "ADR: Sessionの保存方式").length, 1);

    // 元Taskは明示的な依存がないため、文書反映待ちでも結論だけで再開できる。
    const resumptions = ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker"));
    assert.equal(resumptions.resumptions[0].state, "ready");

    // 未受入の文書反映Taskは参照を登録しても反映済みにならない。
    const artifact = { consultationId, projectId: project.id, followupId: followup.id, taskId: followup.taskId, repositoryId: docs.id,
      path: adrPath, commitSha: repository.sha, pullRequestUrl: "https://example.com/compass-docs/pull/12" };
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: next("early") }, "manager-a", "manager")).conflict, "FOLLOWUP_TASK_NOT_ACCEPTED");

    // 検証用Repositoryの実際の変更（commitが変更したpath）を、受け入れるManagerが受入成果物として残す。
    assert.deepEqual(repository.changedPaths(), [adrPath]);
    const deliverable = { repositoryId: docs.id, commitSha: repository.sha, paths: repository.changedPaths(), pullRequestUrl: artifact.pullRequestUrl };
    await acceptThroughWork(kit, followup.taskId, [deliverable]);

    // 無関係なTask・別Repositoryでは反映済みにしない。
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, taskId: original.id, requestId: next("wrong-task") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, repositoryId: appRepository.id, requestId: next("wrong-repo") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, commitSha: repository.sha.slice(0, 12), requestId: next("short-sha") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    // 受入証跡に無いpath・commit・PR（文書が無いpath、架空のSHA、PR以外のURL、別RepositoryのPR、PRの省略）は反映済みにしない。
    for (const mismatch of [
      { path: "docs/does-not-exist.md" },
      { commitSha: "f".repeat(40) },
      { pullRequestUrl: "https://example.com/compass-docs/unrelated-page" },
      { pullRequestUrl: "https://example.com/compass-app/pull/3" },
      { pullRequestUrl: null },
    ]) {
      assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, ...mismatch, requestId: next("mismatch") }, "manager-a", "manager")).conflict, "ARTIFACT_NOT_ACCEPTED", JSON.stringify(mismatch));
    }
    assert.equal(ok(await callTool(kit.app, "get_consultation", { projectId: project.id, consultationId }, "worker-a", "worker")).followups[0].status, "in_progress");
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: next("worker") }, "worker-a", "worker")).code, "FORBIDDEN");

    // 受入済みTaskの実commitを登録する。同じrequestIdの再送・通信断後の別requestIdでも参照は1件。
    const recordId = next("record");
    const recorded = ok(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: recordId }, "manager-a", "manager"));
    assert.equal(recorded.followup.status, "reflected");
    assert.deepEqual(ok(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: recordId }, "manager-a", "manager")).artifact, recorded.artifact);
    assert.equal(ok(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: next("record-retry") }, "manager-a", "manager")).artifact.id, recorded.artifact.id);

    // HumanのWeb UIの詳細から 結論→文書反映Task→受入済みArtifact と元Taskの状態を辿れ、Repositoryの正本と一致する。
    const detail = await json(await as("viewer")(`/api/projects/${project.id}/consultations/${consultationId}`));
    assert.equal(detail.consultation.status, "resolved");
    assert.equal(detail.followups.length, 1);
    assert.equal(detail.followups[0].status, "reflected");
    assert.equal(detail.followups[0].task.status, "accepted");
    assert.equal(detail.followups[0].artifacts.length, 1);
    const [saved] = detail.followups[0].artifacts;
    assert.equal(saved.commitSha, repository.sha);
    assert.match(repository.show(saved.path), /SessionはDBに保存する。JWTは採用しない/);
    assert.deepEqual(detail.waitingTasks.map((task: { taskId: string; state: string }) => [task.taskId, task.state]), [[original.id, "ready"]]);

    // Activityは要約と参照だけで、会話やADR本文を複製しない。
    const activities = (await json(await as("viewer")(`/api/projects/${project.id}/activities?limit=50`))).activities as { id: string; type: string; refs: { kind: string }[] }[];
    const requestedActivity = activities.find((activity) => activity.type === "consultation.followup_requested");
    const reflectedActivity = activities.find((activity) => activity.type === "consultation.followup_reflected");
    assert.ok(requestedActivity && reflectedActivity);
    assert.equal((await json(await as("viewer")(`/api/projects/${project.id}/activities/${reflectedActivity.id}`))).activity.body, null);
    assert.deepEqual(reflectedActivity.refs.map(({ kind }) => kind), ["consultation", "task", "project_resource", "url"]);
    assert.equal(activities.filter((activity) => activity.type === "consultation.followup_reflected").length, 1);
  } finally {
    await kit.database.destroy();
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("明示的な依存だけが元Taskの再開を待たせ、反映済みの登録後に再開できる", async () => {
  const kit = await open();
  const repository = await commitAdr("運用ルール");
  try {
    const seeded = await seed(kit);
    const { project, docs } = seeded;
    const { task: original, consultationId } = await resolveDesignConsultation(kit, seeded);
    const requested = ok(await callTool(kit.app, "request_consultation_followup", {
      consultationId, ...followupInput(seeded, { kind: "policy", title: "Policy: Session運用", resumptionDependency: "実装が参照する運用ルールを先に確定する" }), requestId: next("followup"),
    }, "manager-a", "manager"));
    assert.equal(requested.followup.blocksResumption, true);
    const waiting = ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker")).resumptions[0];
    assert.equal(waiting.state, "waiting");
    assert.match(waiting.failureReason, new RegExp(requested.followup.taskId));
    assert.equal(failure(await callTool(kit.app, "resume_consultation_task", { taskId: original.id, runtime, requestId: next("resume-early") }, "worker-a", "worker")).code, "TASK_NOT_CLAIMABLE");

    // 文書反映Taskは元Taskの受入を待たずに通常の経路で受け入れられる（循環しない）。
    await acceptThroughWork(kit, requested.followup.taskId, [{ repositoryId: docs.id, commitSha: repository.sha, paths: [adrPath], pullRequestUrl: null }]);
    // 受入だけでは反映済みではなく、参照の登録までは待機が残る。
    assert.equal(ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker")).resumptions[0].state, "waiting");
    ok(await callTool(kit.app, "record_consultation_artifact", {
      consultationId, projectId: project.id, followupId: requested.followup.id, taskId: requested.followup.taskId, repositoryId: docs.id,
      path: adrPath, commitSha: repository.sha, pullRequestUrl: null, requestId: next("record"),
    }, "manager-a", "manager"));
    assert.equal(ok(await callTool(kit.app, "list_consultation_resumptions", { projectId: project.id }, "worker-a", "worker")).resumptions[0].state, "ready");
    const resumed = ok(await callTool(kit.app, "resume_consultation_task", { taskId: original.id, runtime, requestId: next("resume") }, "worker-a", "worker"));
    assert.equal(resumed.phase, "work");
  } finally {
    await kit.database.destroy();
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("未解決の相談・応答Role以外・別ProjectのRepositoryや相談・Workspace相談からは文書反映を依頼できない", async () => {
  const kit = await open();
  try {
    const seeded = await seed(kit);
    const other = await seed(kit, "Other");
    const { project } = seeded;
    const created = ok(await callTool(kit.app, "create_consultation", {
      projectId: project.id, title: "未解決", question: "q", blockingReason: "b", recommendation: "r", impact: "i", requestId: next("create"),
    }, "worker-a", "worker"));
    const open = created.consultation.id as string;
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId: open, ...followupInput(seeded), requestId: next("unresolved") }, "manager-a", "manager")).conflict, "CONSULTATION_NOT_RESOLVED");

    const { consultationId } = await resolveDesignConsultation(kit, seeded);
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded), requestId: next("worker") }, "worker-a", "worker")).code, "FORBIDDEN");
    // 別ProjectのRepository、別Project（manager-aは両方のManager）から同じ相談IDを指す依頼は拒否し、相談の存在も区別しない。
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded, { repositoryId: other.docs.id }), requestId: next("other-repo") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(other), requestId: next("other-project") }, "manager-a", "manager")).code, "NOT_FOUND");
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded, { kind: "memo" }), requestId: next("kind") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    const detail = await json(await seeded.as("viewer")(`/api/projects/${project.id}/consultations/${consultationId}`));
    assert.deepEqual(detail.followups, []);

    // 成果物なしで受け入れたTaskからは、どの参照も反映済みにならない。
    const requested = ok(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded), requestId: next("followup") }, "manager-a", "manager"));
    await acceptThroughWork(kit, requested.followup.taskId);
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", {
      consultationId, projectId: project.id, followupId: requested.followup.id, taskId: requested.followup.taskId, repositoryId: seeded.docs.id,
      path: adrPath, commitSha: "a".repeat(40), pullRequestUrl: null, requestId: next("no-deliverables"),
    }, "manager-a", "manager")).conflict, "ARTIFACT_NOT_ACCEPTED");

    // Workspace相談はworkspaceIdを付けずにProject IDだけでは見つからない（Project相談として扱わない）。
    await seedWorkspaceGrant(kit.database, project.workspaceId, "strategist-a", "strategist");
    const workspaceConsultation = ok(await callTool(kit.app, "create_consultation", {
      workspaceId: project.workspaceId, title: "優先順位", question: "q", blockingReason: "b", recommendation: "r", impact: "i", requestId: next("ws"),
    }, "strategist-a", "strategist"));
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { consultationId: workspaceConsultation.consultation.id, ...followupInput(seeded), requestId: next("ws-followup") }, "manager-a", "manager")).code, "NOT_FOUND");
  } finally {
    await kit.database.destroy();
  }
});

test("文書反映の依頼・参照は同じschemaでの再起動後も保持される", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-followup-db-"));
  const repository = await commitAdr("再起動後も残る");
  const path = join(directory, "compass.db");
  try {
    let kit = await open(path);
    const seeded = await seed(kit);
    const { consultationId } = await resolveDesignConsultation(kit, seeded);
    const requested = ok(await callTool(kit.app, "request_consultation_followup", { consultationId, ...followupInput(seeded), requestId: next("followup") }, "manager-a", "manager"));
    await acceptThroughWork(kit, requested.followup.taskId, [{ repositoryId: seeded.docs.id, commitSha: repository.sha, paths: [adrPath], pullRequestUrl: null }]);
    ok(await callTool(kit.app, "record_consultation_artifact", {
      consultationId, projectId: seeded.project.id, followupId: requested.followup.id, taskId: requested.followup.taskId, repositoryId: seeded.docs.id,
      path: adrPath, commitSha: repository.sha, pullRequestUrl: null, requestId: next("record"),
    }, "manager-a", "manager"));
    await kit.database.destroy();
    kit = await open(path);
    const detail = ok(await callTool(kit.app, "get_consultation", { projectId: seeded.project.id, consultationId }, "worker-a", "worker"));
    assert.equal(detail.followups[0].status, "reflected");
    assert.equal(detail.followups[0].artifacts[0].commitSha, repository.sha);
    await kit.database.destroy();
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(repository.directory, { recursive: true, force: true });
  }
});

test("Workspace相談の結論は所属Projectのmanagerが文書反映へ引き継ぎ、受入済み成果物の参照までWorkspaceの相談から辿れる", async () => {
  const kit = await open();
  const repository = await commitAdr("全Projectの監査ログは90日保持する");
  try {
    const owner = await createTestHuman(kit.database);
    const asOwner = requestAs(kit.app, owner);
    const workspace = async (name: string) =>
      (await json(await asOwner("/api/workspaces", post({ name, mission: `${name} decides together` })))).workspace as { id: string };
    const project = async (workspaceId: string, name: string, repositoryName: string) =>
      (await json(await asOwner(`/api/workspaces/${workspaceId}/projects`, post({ name, repositories: [{ name: repositoryName, url: `https://github.com/example/${repositoryName}` }] }))))
        .project as { id: string; workspaceId: string; repositories: { id: string }[] };
    const workspaceA = await workspace("Workspace A");
    const workspaceB = await workspace("Workspace B");
    const projectA1 = await project(workspaceA.id, "Project A1", "a1-docs");
    const projectA2 = await project(workspaceA.id, "Project A2", "a2-docs");
    const projectB1 = await project(workspaceB.id, "Project B1", "b1-docs");
    assert.equal((await asOwner(`/api/workspaces/${workspaceA.id}/grants`, post({ principalId: "strategist-a", role: "strategist" }))).status, 201);
    for (const [projectId, principalId, role] of [
      [projectA1.id, "manager-a", "manager"], [projectA1.id, "worker-b", "worker"], [projectA1.id, "reviewer-a", "reviewer"],
      [projectA2.id, "manager-c", "manager"], [projectB1.id, "manager-b", "manager"],
    ] as const) {
      assert.equal((await asOwner(`/api/projects/${projectId}/grants`, post({ principalId, role }))).status, 201);
    }
    const docs = projectA1.repositories[0]!;

    // StrategistがWorkspace相談を作り、Humanの返信からStrategistが結論を整理する。
    const created = ok(await callTool(kit.app, "create_consultation", {
      workspaceId: workspaceA.id, title: "監査ログの保持期間", question: "全Projectで監査ログを何日保持しますか", blockingReason: "各Projectの運用ルールが分岐する",
      options: [{ label: "30日" }, { label: "90日" }], recommendation: "90日", impact: "全Projectの運用", requestId: next("ws-create"),
    }, "strategist-a", "strategist"));
    const consultationId = created.consultation.id as string;
    const base = `/api/workspaces/${workspaceA.id}/consultations/${consultationId}`;
    const reply = await json(await asOwner(`${base}/messages`, post({ body: "90日にしてください", requestId: next("ws-reply") })));
    const scope = { workspaceId: workspaceA.id, consultationId };
    const target = { ...scope, projectId: projectA1.id };
    // 未解決の結論は引き継げない。
    assert.equal(failure(await callTool(kit.app, "get_consultation_handoff_context", target, "manager-a", "manager")).conflict, "CONSULTATION_NOT_RESOLVED");
    const lease = ok(await callTool(kit.app, "acquire_consultation_lease", { ...scope, inputRevision: reply.consultation.revision, requestId: next("ws-lease") }, "strategist-a", "strategist"));
    ok(await callTool(kit.app, "resolve_consultation", {
      ...scope, leaseId: lease.lease.id, expectedRevision: reply.consultation.revision, conclusion: "監査ログは全Projectで90日保持する",
      rationale: "Humanの回答", selectedOption: 1, basisMessageIds: [reply.message.id], requestId: next("ws-resolve"),
    }, "strategist-a", "strategist"));

    // 所属Projectのmanagerは、Workspace Grantなしで結論を読める（会話本文は含めない）。
    const context = ok(await callTool(kit.app, "get_consultation_handoff_context", target, "manager-a", "manager"));
    assert.equal(context.resolution.conclusion, "監査ログは全Projectで90日保持する");
    assert.equal(JSON.stringify(context).includes("90日にしてください"), false);
    assert.deepEqual(context.followups, []);

    // 権限不足・所属しないProjectは拒否する。StrategistはProjectのWorkを起票しない。
    const input = { ...target, ...followupInput({ project: projectA1, docs }, { kind: "policy", title: "Policy: 監査ログの保持期間", decision: "監査ログは90日保持する", verification: "Policyに90日の保持と対象が記載されていること" }) };
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { ...input, requestId: next("as-strategist") }, "strategist-a", "strategist")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { ...input, requestId: next("as-worker") }, "worker-b", "worker")).code, "FORBIDDEN");
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { ...input, projectId: projectB1.id, repositoryId: projectB1.repositories[0]!.id, requestId: next("other-workspace") }, "manager-b", "manager")).code, "NOT_FOUND");
    assert.equal(failure(await callTool(kit.app, "get_consultation_handoff_context", { ...target, projectId: projectB1.id }, "manager-b", "manager")).code, "NOT_FOUND");
    // manager-aはProject B1のGrantを持たない。
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { ...input, projectId: projectB1.id, requestId: next("no-grant") }, "manager-a", "manager")).code, "FORBIDDEN");
    // 反映先Repositoryは反映担当Projectに登録されたものだけ。
    assert.equal(failure(await callTool(kit.app, "request_consultation_followup", { ...input, repositoryId: projectA2.repositories[0]!.id, requestId: next("a2-repo") }, "manager-a", "manager")).code, "VALIDATION_ERROR");

    // 所属Project A1のmanagerが起票する。同じ依頼の再送は同じTaskを返す。
    const requested = ok(await callTool(kit.app, "request_consultation_followup", { ...input, requestId: next("ws-followup") }, "manager-a", "manager")).followup;
    assert.equal(requested.projectId, projectA1.id);
    assert.equal(requested.project.name, "Project A1");
    assert.equal(ok(await callTool(kit.app, "request_consultation_followup", { ...input, requestId: next("ws-followup-retry") }, "manager-a", "manager")).followup.taskId, requested.taskId);
    const docTask = await json(await asOwner(`/api/projects/${projectA1.id}/tasks/${requested.taskId}`));
    assert.ok(docTask.task.description.includes(consultationId));

    // 受入時のPRはそのRepositoryのpull requestだけ。受入証跡と一致する参照だけを登録できる。
    const pullRequestUrl = "https://github.com/example/a1-docs/pull/5";
    const deliverable = { repositoryId: docs.id, commitSha: repository.sha, paths: repository.changedPaths(), pullRequestUrl };
    const taskId = requested.taskId as string;
    const work = ok(await callTool(kit.app, "claim_task", { taskId, requestId: next("claim") }, "worker-b", "worker"));
    ok(await callTool(kit.app, "add_task_comment", { taskId, claimId: work.claimId, body: "Policyを追加した", requestId: next("comment") }, "worker-b", "worker"));
    ok(await callTool(kit.app, "complete_task", { taskId, claimId: work.claimId, requestId: next("complete") }, "worker-b", "worker"));
    const review = ok(await callTool(kit.app, "claim_review", { taskId, requestId: next("review") }, "reviewer-a", "reviewer"));
    ok(await callTool(kit.app, "reviewed_task", { taskId, claimId: review.claimId, requestId: next("reviewed") }, "reviewer-a", "reviewer"));
    const acceptance = ok(await callTool(kit.app, "claim_acceptance", { taskId, requestId: next("acceptance") }, "manager-a", "manager"));
    for (const invalid of [
      { ...deliverable, pullRequestUrl: "https://github.com/example/b1-docs/pull/5" },
      { ...deliverable, pullRequestUrl: "https://github.com/example/a1-docs/issues/5" },
      { ...deliverable, repositoryId: projectB1.repositories[0]!.id },
    ]) {
      assert.equal(failure(await callTool(kit.app, "accept_task", { taskId, claimId: acceptance.claimId, deliverables: [invalid], requestId: next("bad-accept") }, "manager-a", "manager")).code, "VALIDATION_ERROR");
    }
    ok(await callTool(kit.app, "accept_task", { taskId, claimId: acceptance.claimId, deliverables: [deliverable], requestId: next("accept") }, "manager-a", "manager"));

    const artifact = { ...target, followupId: requested.id, taskId, repositoryId: docs.id, path: adrPath, commitSha: repository.sha, pullRequestUrl };
    // 同じWorkspaceの別Project（A2）のmanagerは、A1が担当する依頼へ登録できない。
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, projectId: projectA2.id, requestId: next("a2") }, "manager-c", "manager")).code, "NOT_FOUND");
    assert.equal(failure(await callTool(kit.app, "record_consultation_artifact", { ...artifact, commitSha: "f".repeat(40), requestId: next("fake-sha") }, "manager-a", "manager")).conflict, "ARTIFACT_NOT_ACCEPTED");
    const recorded = ok(await callTool(kit.app, "record_consultation_artifact", { ...artifact, requestId: next("record") }, "manager-a", "manager"));
    assert.equal(recorded.followup.status, "reflected");

    // Workspace相談の詳細から 結論→Project A1の文書反映Task→受入済みArtifact を辿れ、Repositoryの正本と一致する。
    const detail = await json(await asOwner(base));
    assert.equal(detail.followups.length, 1);
    assert.equal(detail.followups[0].status, "reflected");
    assert.equal(detail.followups[0].project.id, projectA1.id);
    assert.equal(detail.followups[0].task.status, "accepted");
    assert.equal(detail.followups[0].artifacts[0].commitSha, repository.sha);
    assert.match(repository.show(detail.followups[0].artifacts[0].path), /90日保持/);
    assert.deepEqual(detail.waitingTasks, []);

    // Project A1のActivityはWorkspace相談への参照と成果物の参照だけを持つ。
    const activities = (await json(await asOwner(`/api/projects/${projectA1.id}/activities?limit=50`))).activities as { type: string; body: string | null; refs: { kind: string; id?: string }[] }[];
    const reflected = activities.find((activity) => activity.type === "consultation.followup_reflected");
    assert.ok(reflected);
    assert.deepEqual(reflected.refs.map(({ kind }) => kind), ["workspace_consultation", "task", "project_resource", "url"]);
    assert.equal(reflected.refs[0]!.id, consultationId);
  } finally {
    await kit.database.destroy();
    await rm(repository.directory, { recursive: true, force: true });
  }
});
