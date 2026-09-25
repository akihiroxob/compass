import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { UnauthenticatedError } from "../../application/error/UnauthenticatedError.ts";
import { agentPrincipalOf, type Caller } from "../../application/service/RuntimeAuthorizationService.ts";
import type { ApplicationServices } from "../../container.ts";
import { StoryStatus } from "../../domain/model/execution/StoryStatus.ts";
import { TaskStatus } from "../../domain/model/execution/TaskStatus.ts";
import { execute } from "./toolExecution.ts";

const requestIdSchema = z.string().min(1).describe("Caller-generated idempotency key");
const claimIdSchema = z.string().uuid().describe("Current Task Claim ID");

const taskStatusSchema = z.enum([
  TaskStatus.TODO,
  TaskStatus.DOING,
  TaskStatus.CANCELED,
  TaskStatus.IN_REVIEW,
  TaskStatus.WAIT_ACCEPT,
  TaskStatus.ACCEPTED,
  TaskStatus.REJECTED,
]);

/**
 * Execution（旧Wachaから移植したStory / Task / Claim）のtool。tool名・入力・結果は旧Wachaの契約を維持する。
 * `list_projects`・`get_role_instructions`は移植せず、Directionの既存toolを使う。
 * 認可・状態遷移・冪等性はapplication service（TaskCoordinationService）が持ち、ここはPrincipalを渡すだけ。
 * PrincipalなしはUNAUTHENTICATED（PrincipalはBearerのAgent Credential・trusted-localのAgent名から解決し、tool入力からは受け取らない）。
 * Runtime Credentialは`list_changes`だけを`execution:change:read` scopeで呼べる。
 */
export const registerExecutionTools = (server: McpServer, services: ApplicationServices, caller: Caller) => {
  const coordination = services.taskCoordinationService;
  const principal = agentPrincipalOf(caller);
  const asPrincipal = <T>(operation: (principalId: string) => Promise<T>) =>
    execute(async () => {
      if (principal === null) throw new UnauthenticatedError();
      return operation(principal);
    });

  server.registerTool(
    "list_stories",
    {
      title: "List Stories",
      description:
        "List Execution Stories of a Project. Stories created from an Outcome carry outcomeId, originDecisionId, the fixed " +
        "successCriteria and the constraints snapshotted at creation, the target repository and the correlationId. " +
        "Requires Authorization: Bearer <AgentName> with any Role Grant in the Project.",
      inputSchema: {
        projectId: z.string().min(1),
        status: z.enum([StoryStatus.TODO, StoryStatus.DOING, StoryStatus.DONE, StoryStatus.CANCELED]).optional(),
      },
    },
    ({ projectId, status }) => asPrincipal((principalId) => coordination.listStories(principalId, projectId, status)),
  );
  server.registerTool(
    "list_tasks",
    {
      title: "List Tasks",
      description:
        "List Task facts or caller-claimable phase candidates. availableFor uses the caller Role, self-action policy, Task state, and active Claims.",
      inputSchema: {
        projectId: z.string().min(1),
        filter: z
          .object({
            status: z.array(taskStatusSchema).optional(),
            availableFor: z.enum(["work", "review", "acceptance"]).optional(),
            storyId: z.string().min(1).optional(),
          })
          .optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ projectId, filter, limit }) =>
      asPrincipal((principalId) => coordination.listTasks(principalId, projectId, filter, limit)),
  );
  server.registerTool(
    "list_task_comments",
    {
      title: "List Task Comments",
      description: "List Claim-bound handoff comments for a Task.",
      inputSchema: { taskId: z.string().min(1) },
    },
    ({ taskId }) => asPrincipal((principalId) => coordination.listTaskComments(principalId, taskId)),
  );
  server.registerTool(
    "list_changes",
    {
      title: "List Changes",
      description:
        "Read append-only Execution changes of a Project after a durable cursor. An external Runtime keeps the cursor " +
        "(nextCursor) and resumes from it; Compass does not track delivery. Requires an Agent with any Role Grant in the Project, " +
        "or a Runtime Credential of the Project with the execution:change:read scope.",
      inputSchema: {
        projectId: z.string().min(1),
        afterCursor: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
    },
    ({ projectId, afterCursor, limit }) =>
      caller !== null && typeof caller === "object" && caller.kind === "runtime"
        ? execute(async () => {
            await services.runtimeAuthorizationService.requireScope(caller, projectId, "execution:change:read");
            return coordination.listChangesOfProject(projectId, afterCursor, limit);
          })
        : asPrincipal((principalId) => coordination.listChanges(principalId, projectId, afterCursor, limit)),
  );

  server.registerTool(
    "issue_story",
    {
      title: "Issue Story",
      description:
        "Create a Story as a Manager. To hand off a Direction Outcome, pass outcomeId: Compass then snapshots the Outcome's fixed " +
        "Success Criteria, its origin Decision and the Project's current Constraints into the Story (NOT_FOUND if the Outcome is not " +
        "in this Project, CONFLICT if it is not active). repositoryId (a Repository registered on the Project) records the target " +
        "Repository; checking it out is the Runtime's or Agent's job. correlationId defaults to outcome:<outcomeId> and is unique per " +
        "Project: resending the same handoff, even with a new requestId after a timeout, returns the existing Story instead of creating a " +
        "second one, while a different Story under the same correlationId fails with IDEMPOTENCY_CONFLICT. Not available in an archived Project.",
      inputSchema: {
        projectId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        outcomeId: z.string().min(1).optional().describe("Direction Outcome ID to hand off"),
        repositoryId: z.string().min(1).optional().describe("Repository ID registered on the Project"),
        correlationId: z.string().min(1).optional().describe("Handoff correlation ID, unique per Project"),
        requestId: requestIdSchema,
      },
    },
    ({ requestId, ...input }) => asPrincipal((principalId) => coordination.issueStory(principalId, input, requestId)),
  );
  server.registerTool(
    "edit_story",
    {
      title: "Edit Story",
      description: "Update a Story as a Manager.",
      inputSchema: {
        projectId: z.string().min(1),
        storyId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        sortOrder: z.number().int().min(0).optional(),
        requestId: requestIdSchema,
      },
    },
    ({ requestId, ...input }) => asPrincipal((principalId) => coordination.editStory(principalId, input, requestId)),
  );
  server.registerTool(
    "complete_story",
    {
      title: "Complete Story",
      description: "Complete a settled Story as a Manager.",
      inputSchema: { storyId: z.string().min(1), requestId: requestIdSchema },
    },
    ({ storyId, requestId }) => asPrincipal((principalId) => coordination.completeStory(principalId, storyId, requestId)),
  );
  server.registerTool(
    "cancel_story",
    {
      title: "Cancel Story",
      description: "Cancel a Story with a durable reason.",
      inputSchema: { storyId: z.string().min(1), reason: z.string().min(1), requestId: requestIdSchema },
    },
    ({ storyId, reason, requestId }) =>
      asPrincipal((principalId) => coordination.cancelStory(principalId, storyId, reason, requestId)),
  );
  server.registerTool(
    "issue_task",
    {
      title: "Issue Task",
      description:
        "Create a planned Task as a Manager or a technical follow-up discovered by a Worker or Reviewer. " +
        "taskKey is a logical ID unique within the Story: re-sending the same taskKey with the same content returns the " +
        "existing Task even with a new requestId, and different content is IDEMPOTENCY_CONFLICT. taskKey is required " +
        "under a Story with a correlationId (Outcome handoff). Not available in an archived Project.",
      inputSchema: {
        projectId: z.string().min(1),
        storyId: z.string().min(1).optional(),
        title: z.string().min(1),
        description: z.string().optional(),
        taskKey: z
          .string()
          .min(1)
          .max(200)
          .optional()
          .describe("Logical Task ID unique within the Story; deterministic from the plan (e.g. criterion-1-api)"),
        requestId: requestIdSchema,
      },
    },
    ({ requestId, ...input }) => asPrincipal((principalId) => coordination.issueTask(principalId, input, requestId)),
  );
  server.registerTool(
    "edit_task",
    {
      title: "Edit Task",
      description: "Update a Task as a Manager.",
      inputSchema: {
        projectId: z.string().min(1),
        taskId: z.string().min(1),
        title: z.string().min(1),
        description: z.string().optional(),
        sortOrder: z.number().int().min(0).optional(),
        requestId: requestIdSchema,
      },
    },
    ({ requestId, ...input }) => asPrincipal((principalId) => coordination.editTask(principalId, input, requestId)),
  );
  server.registerTool(
    "cancel_task",
    {
      title: "Cancel Task",
      description: "Cancel a todo or doing Task and fence any current Claim.",
      inputSchema: { taskId: z.string().min(1), reason: z.string().min(1), requestId: requestIdSchema },
    },
    ({ taskId, reason, requestId }) =>
      asPrincipal((principalId) => coordination.cancelTask(principalId, taskId, reason, requestId)),
  );

  server.registerTool(
    "claim_task",
    {
      title: "Claim Task",
      description: "Atomically acquire a work Claim for a selected Task. Not available in an archived Project.",
      inputSchema: { taskId: z.string().min(1), requestId: requestIdSchema },
    },
    ({ taskId, requestId }) => asPrincipal((principalId) => coordination.claimTask(principalId, taskId, requestId)),
  );
  server.registerTool(
    "claim_review",
    {
      title: "Claim Review",
      description: "Atomically acquire a review Claim for a selected in_review Task.",
      inputSchema: { taskId: z.string().min(1), requestId: requestIdSchema },
    },
    ({ taskId, requestId }) => asPrincipal((principalId) => coordination.claimReview(principalId, taskId, requestId)),
  );
  server.registerTool(
    "claim_acceptance",
    {
      title: "Claim Acceptance",
      description:
        "Acquire an acceptance Claim. An in_review Task is atomically moved to wait_accept as a Manager direct review.",
      inputSchema: { taskId: z.string().min(1), requestId: requestIdSchema },
    },
    ({ taskId, requestId }) => asPrincipal((principalId) => coordination.claimAcceptance(principalId, taskId, requestId)),
  );
  server.registerTool(
    "renew_claim",
    {
      title: "Renew Claim",
      description: "Extend the current Task Claim lease. This is not an agent heartbeat.",
      inputSchema: { claimId: claimIdSchema },
    },
    ({ claimId }) => asPrincipal((principalId) => coordination.renewClaim(principalId, claimId)),
  );
  server.registerTool(
    "release_claim",
    {
      title: "Release Claim",
      description: "Release the current Task Claim with a reason.",
      inputSchema: { claimId: claimIdSchema, reason: z.string().min(1), requestId: requestIdSchema },
    },
    ({ claimId, reason, requestId }) =>
      asPrincipal((principalId) => coordination.releaseClaim(principalId, claimId, reason, requestId)),
  );
  server.registerTool(
    "add_task_comment",
    {
      title: "Add Task Comment",
      description: "Add a handoff or verification comment under the current Claim.",
      inputSchema: {
        taskId: z.string().min(1),
        claimId: claimIdSchema,
        body: z.string().min(1),
        requestId: requestIdSchema,
      },
    },
    ({ taskId, claimId, body, requestId }) =>
      asPrincipal((principalId) => coordination.addTaskComment(principalId, taskId, claimId, body, requestId)),
  );
  server.registerTool(
    "complete_task",
    {
      title: "Complete Task",
      description: "Complete work under the current Claim and move the Task to in_review.",
      inputSchema: { taskId: z.string().min(1), claimId: claimIdSchema, requestId: requestIdSchema },
    },
    ({ taskId, claimId, requestId }) =>
      asPrincipal((principalId) => coordination.completeTask(principalId, taskId, claimId, requestId)),
  );
  server.registerTool(
    "reviewed_task",
    {
      title: "Reviewed Task",
      description: "Approve implementation under the current Review Claim.",
      inputSchema: { taskId: z.string().min(1), claimId: claimIdSchema, requestId: requestIdSchema },
    },
    ({ taskId, claimId, requestId }) =>
      asPrincipal((principalId) => coordination.reviewedTask(principalId, taskId, claimId, requestId)),
  );
  server.registerTool(
    "accept_task",
    {
      title: "Accept Task",
      description: "Accept a wait_accept Task under the current Acceptance Claim.",
      inputSchema: { taskId: z.string().min(1), claimId: claimIdSchema, requestId: requestIdSchema },
    },
    ({ taskId, claimId, requestId }) =>
      asPrincipal((principalId) => coordination.acceptTask(principalId, taskId, claimId, requestId)),
  );
  server.registerTool(
    "reject_task",
    {
      title: "Reject Task",
      description: "Reject a Task under the current Review or Acceptance Claim.",
      inputSchema: {
        taskId: z.string().min(1),
        claimId: claimIdSchema,
        reason: z.string().min(1),
        requestId: requestIdSchema,
      },
    },
    ({ taskId, claimId, reason, requestId }) =>
      asPrincipal((principalId) => coordination.rejectTask(principalId, taskId, claimId, reason, requestId)),
  );
};
