import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { consultationStatuses } from "@compass/collaboration";
import { agentPrincipalOf, type Caller } from "@compass/access";
import type { OperationServices } from "../bootstrap/createApplicationServices.ts";
import { execute } from "./toolExecution.ts";

const target = { projectId: z.string().min(1), consultationId: z.string().min(1) };
const role = z.string().optional().describe("Project Execution Role to act as (manager, worker, reviewer); defaults to X-Compass-Active-Role");
const requestId = z.string().min(1).describe("Caller-generated idempotency key");
const roleNote =
  "The Principal comes from Authorization; role must be a Project Execution Role you hold (defaults to X-Compass-Active-Role). " +
  "Workspace Direction Role Grants do not apply. ";
const idempotencyNote = "The same requestId returns the saved result; reusing it with different input fails with CONFLICT. ";
const leaseNote =
  "Requires leaseId from acquire_consultation_lease for the current revision and expectedRevision equal to the current revision: " +
  "if a Human replied meanwhile the revision moved on and the call fails with CONFLICT (conflict STALE_REVISION); read the Consultation " +
  "again, acquire a new lease and respond to the new input. An expired lease fails with CONFLICT (LEASE_EXPIRED). ";

/**
 * Project相談（Collaboration）のtool。入力規則・状態遷移・版とleaseの照合・冪等性は共通のuse caseが持ち、ここはPrincipalとRoleを渡すだけ。
 * Humanの明示決定（`human_decision`）はWeb UI専用で、ここには無い。Agentの結論は常に`agent_summary`として記録される。
 * 未知の項目（`source`等）はMCP境界で捨てず、use caseの厳格な検査でVALIDATION_ERRORにする。
 */
export const registerConsultationTools = (server: McpServer, services: OperationServices, caller: Caller) => {
  const principal = agentPrincipalOf(caller);
  const consultations = services.agentConsultationUseCases;

  server.registerTool(
    "create_consultation",
    {
      title: "Create Consultation",
      description:
        "Ask the Humans of a Project to decide a design or requirement question that Agents cannot settle within existing " +
        "requirements, policies and permissions (do not consult on routine decisions already allowed). Give title, question " +
        "(what has to be decided), blockingReason (why work cannot proceed without it), options [{label, description?}], " +
        "recommendation, impact and refs ({kind:'url', url}, {kind:'project_resource', resourceId, path?, revision?}, " +
        "{kind:'task'|'story'|'consultation', id} of this Project; do not copy Repository / Docs content). The Consultation starts " +
        "waiting_human. To change the conclusion of a resolved or canceled Consultation, create a new one with supersedesConsultationId. " +
        roleNote + idempotencyNote + "An archived Project fails with CONFLICT.",
      inputSchema: z.looseObject({
        projectId: z.string().min(1),
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
    ({ projectId, role: actingRole, ...input }) => execute(() => consultations.create(principal, projectId, actingRole, input)),
  );
  server.registerTool(
    "list_consultations",
    {
      title: "List Consultations",
      description:
        "List the Consultations of a Project, most recently updated first, optionally filtered by status " +
        "(waiting_human, waiting_agent, resolved, canceled). waiting_agent means a Human replied and an Agent response is due. " +
        "Requires a Project Execution Role Grant (the active role's Grant with X-Compass-Active-Role).",
      inputSchema: { projectId: z.string().min(1), status: z.enum(consultationStatuses).optional() },
    },
    ({ projectId, status }) => execute(() => consultations.list(principal, projectId, status === undefined ? {} : { status })),
  );
  server.registerTool(
    "get_consultation",
    {
      title: "Get Consultation",
      description:
        "Get a Consultation with its question, options, recommendation, impact and refs, the conversation (messages in order, each " +
        "with author kind human or agent), the resolution (source human_decision or agent_summary) and the Agent currently holding " +
        "the response lease (responder). revision is the version to pass as inputRevision / expectedRevision. " +
        "A Consultation of another Project fails with NOT_FOUND. Requires a Project Execution Role Grant.",
      inputSchema: target,
    },
    ({ projectId, consultationId }) => execute(() => consultations.get(principal, projectId, consultationId)),
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
        "fails with CONFLICT (NOT_WAITING_AGENT). " + roleNote + idempotencyNote,
      inputSchema: z.looseObject({ ...target, inputRevision: z.number().int(), role, requestId }),
    },
    ({ projectId, consultationId, role: actingRole, ...input }) =>
      execute(() => consultations.acquireLease(principal, projectId, consultationId, actingRole, input)),
  );
  server.registerTool(
    "reply_consultation",
    {
      title: "Reply Consultation",
      description:
        "Add an Agent message to a waiting_agent Consultation: an answer to the Human or an additional question. The " +
        "Consultation becomes waiting_human again; the lease is released. Messages are append-only: to correct your own message, " +
        "reply with correctsMessageId. Do not use a reply to record a decision; a manager records the conclusion with " +
        "resolve_consultation. " + leaseNote + roleNote + idempotencyNote,
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
    ({ projectId, consultationId, role: actingRole, ...input }) =>
      execute(() => consultations.reply(principal, projectId, consultationId, actingRole, input)),
  );
  server.registerTool(
    "resolve_consultation",
    {
      title: "Resolve Consultation",
      description:
        "Manager only. Record the conclusion organized from the Human replies and resolve the Consultation in one step: " +
        "conclusion, rationale, applicability?, selectedOption? (index of options) and basisMessageIds (must include at least one " +
        "Human message the conclusion is based on). The resolution is recorded as source agent_summary by you; it is never a Human " +
        "decision. Do not ask the Human to approve again when the reply is already clear. " + leaseNote + idempotencyNote,
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
    ({ projectId, consultationId, ...input }) => execute(() => consultations.resolve(principal, projectId, consultationId, input)),
  );
  server.registerTool(
    "cancel_consultation",
    {
      title: "Cancel Consultation",
      description:
        "Manager only. Cancel an open Consultation that is no longer needed, with a reason. expectedRevision must be the current " +
        "revision (CONFLICT STALE_REVISION otherwise). A resolved or canceled Consultation fails with CONFLICT (CONSULTATION_CLOSED). " +
        idempotencyNote,
      inputSchema: z.looseObject({ ...target, expectedRevision: z.number().int(), reason: z.string(), requestId }),
    },
    ({ projectId, consultationId, ...input }) => execute(() => consultations.cancel(principal, projectId, consultationId, input)),
  );
};
