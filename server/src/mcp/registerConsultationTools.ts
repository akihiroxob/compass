import { z } from "zod";
import { consultationStatuses, followupKinds, type ConsultationScope } from "@compass/collaboration";
import { agentPrincipalOf, type Caller } from "@compass/access";
import { ValidationError } from "@compass/shared";
import type { OperationServices } from "../bootstrap/createApplicationServices.ts";
import { execute } from "./toolExecution.ts";
import { runtimeToolMeta, type ToolRegistrar } from "./toolContext.ts";

const scopeIds = {
  projectId: z.string().min(1).optional().describe("Project of a Project Consultation (give exactly one of projectId and workspaceId)"),
  workspaceId: z.string().min(1).optional().describe("Workspace of a Workspace Consultation (give exactly one of projectId and workspaceId)"),
};
const target = { ...scopeIds, consultationId: z.string().min(1) };
const role = z
  .string()
  .optional()
  .describe("Role to act as: a Project Execution Role (manager, worker, reviewer) for a Project Consultation or a Workspace Direction Role " +
    "(strategist, researcher, evaluator) for a Workspace Consultation; defaults to X-Compass-Active-Role");
const requestId = z.string().min(1).describe("Caller-generated idempotency key");
const scopeNote =
  "Give projectId for a Project Consultation or workspaceId for a Workspace Consultation (exactly one). The scope is the owner of the " +
  "decision: a Project's design or requirement goes to the Project, a Workspace's direction (Intent / Outcome) goes to the Workspace; do " +
  "not move a Project question to the Workspace because it affects several Projects. A Consultation is found only in its own scope. ";
const roleNote =
  "The Principal comes from Authorization; role must be a Role of the scope you hold (Project Execution Role or Workspace Direction Role, " +
  "defaults to X-Compass-Active-Role). Grants are not inherited between a Workspace and its Projects. ";
const idempotencyNote = "The same requestId returns the saved result; reusing it with different input fails with CONFLICT. ";
const leaseNote =
  "Requires leaseId from acquire_consultation_lease for the current revision and expectedRevision equal to the current revision: " +
  "if a Human replied meanwhile the revision moved on and the call fails with CONFLICT (conflict STALE_REVISION); read the Consultation " +
  "again, acquire a new lease and respond to the new input. An expired lease fails with CONFLICT (LEASE_EXPIRED). ";

/** `projectId`・`workspaceId`のどちらか一方から相談のscopeを決める。両方・どちらも無い入力はVALIDATION_ERROR。 */
const scopeOf = ({ projectId, workspaceId }: { projectId?: string | undefined; workspaceId?: string | undefined }): ConsultationScope => {
  if ((projectId === undefined) === (workspaceId === undefined)) {
    throw new ValidationError("Consultation input is invalid", [
      { path: "projectId", message: "give exactly one of projectId (Project Consultation) and workspaceId (Workspace Consultation)" },
    ]);
  }
  return projectId !== undefined ? { kind: "project", projectId } : { kind: "workspace", workspaceId: workspaceId! };
};

/**
 * 相談（Collaboration）のtool。Project相談とWorkspace相談を同じtoolで扱い、`projectId`・`workspaceId`のどちらか一方でscopeを指す。
 * 入力規則・状態遷移・版とleaseの照合・冪等性は共通のuse caseが持ち、ここはPrincipal・Role・scopeを渡すだけ。
 * Humanの明示決定（`human_decision`）はWeb UI専用で、ここには無い。Agentの結論は常に`agent_summary`として記録される。
 * 未知の項目（`source`等）はMCP境界で捨てず、use caseの厳格な検査でVALIDATION_ERRORにする。
 * 応答待ちの読取り（`get_project_consultation_state`・`get_workspace_consultation_state`）はOrchestrator向けで、Runtime Credentialだけで読む。
 */
export const registerConsultationTools = (server: ToolRegistrar, services: OperationServices, caller: Caller) => {
  const principal = agentPrincipalOf(caller);
  const consultations = services.agentConsultationUseCases;

  server.registerTool(
    "create_consultation",
    {
      title: "Create Consultation",
      description:
        "Ask the Humans of a Project or a Workspace to decide a design, requirement or direction question that Agents cannot settle " +
        "within existing requirements, policies and permissions (do not consult on routine decisions already allowed). Give title, " +
        "question (what has to be decided), blockingReason (why work cannot proceed without it), options [{label, description?}], " +
        "recommendation, impact and refs of the same scope (do not copy Repository / Docs content): {kind:'url', url}; for a Project " +
        "{kind:'project_resource', resourceId, path?, revision?} and {kind:'task'|'story'|'consultation', id}; for a Workspace " +
        "{kind:'intent', id}, {kind:'outcome', intentId, id} and {kind:'consultation', id}. The Consultation starts waiting_human. To " +
        "change the conclusion of a resolved or canceled Consultation, create a new one with supersedesConsultationId. " +
        scopeNote + roleNote + idempotencyNote + "An archived Project or Workspace fails with CONFLICT.",
      inputSchema: z.looseObject({
        ...scopeIds,
        role,
        title: z.string(),
        question: z.string(),
        blockingReason: z.string(),
        options: z.array(z.object({ label: z.string(), description: z.string().nullable().optional() })).optional(),
        recommendation: z.string(),
        impact: z.string(),
        refs: z.array(z.record(z.string(), z.unknown())).optional(),
        supersedesConsultationId: z.string().optional(),
        requestId,
      }),
    },
    ({ projectId, workspaceId, role: actingRole, ...input }) =>
      execute(() => consultations.create(principal, scopeOf({ projectId, workspaceId }), actingRole, input)),
  );
  server.registerTool(
    "list_consultations",
    {
      title: "List Consultations",
      description:
        "List the Consultations of a Project or a Workspace, most recently updated first, optionally filtered by status " +
        "(waiting_human, waiting_agent, resolved, canceled). waiting_agent means a Human replied and an Agent response is due. " +
        "A Workspace list does not include the Consultations of its Projects. " + scopeNote +
        "Requires a Role Grant of the scope (the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { ...scopeIds, status: z.enum(consultationStatuses).optional() },
    },
    ({ projectId, workspaceId, status }) =>
      execute(() => consultations.list(principal, scopeOf({ projectId, workspaceId }), status === undefined ? {} : { status })),
  );
  server.registerTool(
    "get_consultation",
    {
      title: "Get Consultation",
      description:
        "Get a Consultation with its question, options, recommendation, impact and refs, the conversation (messages in order, each " +
        "with author kind human or agent), the resolution (source human_decision or agent_summary) and the Agent currently holding " +
        "the response lease (responder), the document follow-ups with their reflection status (pending, in_progress, reflected, " +
        "canceled) and artifacts, and the Tasks waiting on it (waitingTasks). revision is the version to pass as inputRevision / " +
        "expectedRevision. " +
        "A Consultation of another scope fails with NOT_FOUND. " + scopeNote + "Requires a Role Grant of the scope.",
      inputSchema: target,
    },
    ({ projectId, workspaceId, consultationId }) =>
      execute(() => consultations.get(principal, scopeOf({ projectId, workspaceId }), consultationId)),
  );
  server.registerTool(
    "acquire_consultation_lease",
    {
      title: "Acquire Consultation Lease",
      description:
        "Acquire the short response lease of a waiting_agent Consultation for inputRevision (its current revision) before " +
        "replying or resolving, so that only one Agent responds to the same Human input. The lease is separate from Task Claims " +
        "and expires after a few minutes; acquiring again while you hold it extends it. Another Agent's active lease fails with " +
        "CONFLICT (LEASE_HELD); an old inputRevision fails with CONFLICT (STALE_REVISION); a Consultation not waiting for an Agent " +
        "fails with CONFLICT (NOT_WAITING_AGENT). " + scopeNote + roleNote + idempotencyNote,
      inputSchema: z.looseObject({ ...target, inputRevision: z.number().int(), role, requestId }),
    },
    ({ projectId, workspaceId, consultationId, role: actingRole, ...input }) =>
      execute(() => consultations.acquireLease(principal, scopeOf({ projectId, workspaceId }), consultationId, actingRole, input)),
  );
  server.registerTool(
    "reply_consultation",
    {
      title: "Reply Consultation",
      description:
        "Add an Agent message to a waiting_agent Consultation: an answer to the Human or an additional question. The " +
        "Consultation becomes waiting_human again; the lease is released. Messages are append-only: to correct your own message, " +
        "reply with correctsMessageId. Do not use a reply to record a decision; the responder Role (manager for a Project, " +
        "strategist for a Workspace) records the conclusion with resolve_consultation. " + leaseNote + scopeNote + roleNote + idempotencyNote,
      inputSchema: z.looseObject({
        ...target,
        leaseId: z.string().min(1),
        expectedRevision: z.number().int(),
        body: z.string(),
        correctsMessageId: z.string().optional(),
        role,
        requestId,
      }),
    },
    ({ projectId, workspaceId, consultationId, role: actingRole, ...input }) =>
      execute(() => consultations.reply(principal, scopeOf({ projectId, workspaceId }), consultationId, actingRole, input)),
  );
  server.registerTool(
    "resolve_consultation",
    {
      title: "Resolve Consultation",
      description:
        "Responder Role only: manager for a Project Consultation, strategist for a Workspace Consultation. Record the conclusion " +
        "organized from the Human replies and resolve the Consultation in one step: conclusion, rationale, applicability?, " +
        "selectedOption? (index of options) and basisMessageIds (must include at least one Human message the conclusion is based on). " +
        "The resolution is recorded as source agent_summary by you; it is never a Human decision. Do not ask the Human to approve " +
        "again when the reply is already clear. " + leaseNote + scopeNote + idempotencyNote,
      inputSchema: z.looseObject({
        ...target,
        leaseId: z.string().min(1),
        expectedRevision: z.number().int(),
        conclusion: z.string(),
        rationale: z.string(),
        applicability: z.string().nullable().optional(),
        selectedOption: z.number().int().nullable().optional(),
        basisMessageIds: z.array(z.string()),
        requestId,
      }),
    },
    ({ projectId, workspaceId, consultationId, ...input }) =>
      execute(() => consultations.resolve(principal, scopeOf({ projectId, workspaceId }), consultationId, input)),
  );
  server.registerTool(
    "cancel_consultation",
    {
      title: "Cancel Consultation",
      description:
        "Responder Role only: manager for a Project Consultation, strategist for a Workspace Consultation. Cancel an open " +
        "Consultation that is no longer needed, with a reason. expectedRevision must be the current revision (CONFLICT " +
        "STALE_REVISION otherwise). A resolved or canceled Consultation fails with CONFLICT (CONSULTATION_CLOSED). " + scopeNote + idempotencyNote,
      inputSchema: z.looseObject({ ...target, expectedRevision: z.number().int(), reason: z.string(), requestId }),
    },
    ({ projectId, workspaceId, consultationId, ...input }) =>
      execute(() => consultations.cancel(principal, scopeOf({ projectId, workspaceId }), consultationId, input)),
  );

  // Workspace相談の結論は、Strategistが引継ぎ先に明示した所属Projectだけへ公開する（Grantは継承しない）。
  server.registerTool(
    "hand_off_consultation",
    {
      title: "Hand Off Consultation",
      description:
        "Strategist of the Workspace only. Name a Project of the same Workspace that takes over the conclusion of a resolved Workspace " +
        "Consultation (for example to reflect it in its specification, policy or ADR). Only a named Project's manager can then read the " +
        "conclusion with get_consultation_handoff_context and request document follow-ups; Project Grants never read Workspace " +
        "Consultations otherwise. Decide which Projects need it from the conclusion; nothing is forwarded automatically and no Work " +
        "Task is issued by this call. The same Consultation and Project returns the saved handoff regardless of requestId. A Project of " +
        "another Workspace is NOT_FOUND, an archived Project or Workspace fails with CONFLICT, an unresolved Consultation fails with " +
        "CONFLICT (CONSULTATION_NOT_RESOLVED). " + idempotencyNote,
      inputSchema: z.looseObject({ workspaceId: z.string().min(1), consultationId: z.string().min(1), projectId: z.string().min(1), requestId }),
    },
    ({ workspaceId, consultationId, ...input }) => execute(() => consultations.handOff(principal, workspaceId, consultationId, input)),
  );

  // 文書反映は反映担当Project（projectId）のmanagerが行う。workspaceIdを指定すると、そのWorkspaceのWorkspace相談の結論を引継ぎ先のProjectで扱う。
  const followupTarget = {
    projectId: z.string().min(1).describe("Project that reflects the conclusion in its Repository (you need its manager Grant)"),
    workspaceId: z
      .string()
      .min(1)
      .optional()
      .describe("Give it for a Workspace Consultation: the Workspace that owns the Consultation and handed it off to projectId. Omit for a Project Consultation of projectId"),
    consultationId: z.string().min(1),
  };
  const followupScope = ({ projectId, workspaceId }: { projectId: string; workspaceId?: string | undefined }): ConsultationScope =>
    workspaceId === undefined ? { kind: "project", projectId } : { kind: "workspace", workspaceId };
  const followupNote =
    "Manager of projectId only (no Workspace Grant is needed or used). The Consultation is the Project Consultation of projectId, or with " +
    "workspaceId a Workspace Consultation of that Workspace that its Strategist handed off to projectId (hand_off_consultation); " +
    "otherwise NOT_FOUND. ";
  server.registerTool(
    "get_consultation_handoff_context",
    {
      title: "Get Consultation Handoff Context",
      description:
        "Read the conclusion of a resolved Consultation to hand it to a document Task of your Project: the Consultation (question, " +
        "options, recommendation, refs), its resolution and the follow-ups this Project already holds with their reflection status. " +
        "The conversation is not included. An unresolved Consultation fails with CONFLICT (CONSULTATION_NOT_RESOLVED). " + followupNote,
      inputSchema: followupTarget,
    },
    ({ projectId, workspaceId, consultationId }) =>
      execute(() => consultations.getHandoffContext(principal, projectId, followupScope({ projectId, workspaceId }), consultationId)),
  );
  server.registerTool(
    "request_consultation_followup",
    {
      title: "Request Consultation Follow-up",
      description:
        "Hand the conclusion of a resolved Consultation to a document Task that reflects it in " +
        "a Repository registered in projectId: kind adr (a long-lived structure or technology choice with alternatives and trade-offs), " +
        "specification (continuing requirements) or policy (operational rules). Decide whether a document is needed and which kind; do " +
        "not turn routine permissions, temporary checks or UI dimensions into an ADR, and do not add a Human approval step. Give " +
        "repositoryId, title, purpose, decision (what the document must state), rationale, verification (how the reviewer checks the " +
        "document) and optional storyId. A normal Work Task is issued in the same step for Worker / Reviewer / Manager; it never waits " +
        "for the original Task. The original Task waiting on a Project Consultation resumes on the conclusion alone unless you give " +
        "resumptionDependency (the reason it must wait for this document); only then it waits until the follow-up is reflected. The " +
        "same conclusion, kind, Project and Repository returns the existing follow-up and Task regardless of requestId (CONFLICT " +
        "FOLLOWUP_EXISTS if the content differs). An unresolved Consultation fails with CONFLICT (CONSULTATION_NOT_RESOLVED). " +
        followupNote + idempotencyNote,
      inputSchema: z.looseObject({
        ...followupTarget,
        kind: z.string().describe(`Document kind: ${followupKinds.join(", ")}`),
        repositoryId: z.string(),
        storyId: z.string().optional(),
        title: z.string(),
        purpose: z.string(),
        decision: z.string(),
        rationale: z.string(),
        verification: z.string(),
        resumptionDependency: z.string().nullable().optional(),
        requestId,
      }),
    },
    ({ projectId, workspaceId, consultationId, ...input }) =>
      execute(() => consultations.requestFollowup(principal, projectId, followupScope({ projectId, workspaceId }), consultationId, input)),
  );
  server.registerTool(
    "record_consultation_artifact",
    {
      title: "Record Consultation Artifact",
      description:
        "After the document Task of a follow-up is accepted with deliverables (accept_task), record the reflected document: followupId, " +
        "taskId and repositoryId of that follow-up, the Repository-relative path, the full 40-character commitSha and pullRequestUrl " +
        "(or null) exactly as accepted. The Repository stays the source of truth; Compass keeps only the reference. A Task or " +
        "Repository other than the follow-up's fails with VALIDATION_ERROR; a Task that is not accepted fails with CONFLICT " +
        "(FOLLOWUP_TASK_NOT_ACCEPTED); a path, commit or pull request that is not among the accepted deliverables fails with CONFLICT " +
        "(ARTIFACT_NOT_ACCEPTED). The same follow-up, path and commit returns the saved reference regardless of requestId. " +
        followupNote + idempotencyNote,
      inputSchema: z.looseObject({
        ...followupTarget,
        followupId: z.string(),
        taskId: z.string(),
        repositoryId: z.string(),
        path: z.string(),
        commitSha: z.string(),
        pullRequestUrl: z.string().nullable().optional(),
        requestId,
      }),
    },
    ({ projectId, workspaceId, consultationId, ...input }) =>
      execute(() => consultations.recordArtifact(principal, projectId, followupScope({ projectId, workspaceId }), consultationId, input)),
  );

  server.registerTool("get_project_consultation_state", {
    title: "Get Project Consultation State",
    description: "Project Runtime Credential with runtime:state:read only. Read unprocessed Human input revisions for Manager dispatch. Returns IDs and revisions without conversation text; responses require the Manager's own Agent Credential and response lease.",
    inputSchema: { projectId: z.string() },
    _meta: runtimeToolMeta,
  }, ({ projectId }) => execute(() => services.getProjectConsultationStateUseCase.execute(caller, projectId)));
  server.registerTool("get_workspace_consultation_state", {
    title: "Get Workspace Consultation State",
    description:
      "Workspace Runtime Credential with runtime:state:read only (a Project Credential or a trusted-local Bearer name is rejected). " +
      "Read the unprocessed Human input revisions of the Workspace Consultations for Strategist dispatch; Project Consultations of the " +
      "Workspace are not included. Returns IDs and revisions without conversation text; an archived Workspace returns an empty list. " +
      "Responses require the Strategist's own Agent Credential and response lease.",
    inputSchema: { workspaceId: z.string() },
    _meta: runtimeToolMeta,
  }, ({ workspaceId }) => execute(() => services.getWorkspaceConsultationStateUseCase.execute(caller, workspaceId)));
};
