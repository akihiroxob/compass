import { z } from "zod";
import { UnauthenticatedError } from "@compass/shared";
import { agentPrincipalOf, type Caller } from "@compass/access";
import type { OperationServices } from "../bootstrap/createApplicationServices.ts";
import { StoryStatus, TaskStatus } from "@compass/work";
import { execute } from "./toolExecution.ts";
import { runtimeToolMeta, type ToolRegistrar } from "./toolContext.ts";

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
 * Runtime Credentialは`list_changes`を`execution:change:read`、`record_publication`を`publication:write` scopeで呼べる。
 */
export const registerExecutionTools = (server: ToolRegistrar, services: OperationServices, caller: Caller) => {
  const coordination = services.taskCoordinationService;
  const principal = agentPrincipalOf(caller);
  const asPrincipal = <T>(operation: (principalId: string) => Promise<T>) =>
    execute(async () => {
      if (principal === null) throw new UnauthenticatedError();
      return operation(principal);
    });

  const runtime = z.strictObject({ worktreePath: z.string().min(1), contextPath: z.string().min(1),
    headSha: z.string(), sourceFingerprint: z.string().min(1), pullRequest: z.string().nullable(), verificationRefs: z.array(z.string()) });
  server.registerTool("wait_for_consultation", {
    title: "Wait for Consultation",
    description: "Current Claim owner only. Save artifacts and Runtime Context on disk first. Reserve this Task for all listed open Consultations, retaining its phase and status, then release its Claim atomically. Other Tasks keep running.",
    inputSchema: { taskId: z.string(), claimId: claimIdSchema, consultationIds: z.array(z.string()).min(1), reason: z.string(), runtime, requestId: requestIdSchema },
  }, ({ requestId, ...input }) => asPrincipal((principalId) => coordination.waitForConsultations(principalId, input, requestId)));
  server.registerTool("list_consultation_resumptions", {
    title: "List Consultation Resumptions",
    description: "Reconcile all Consultations and current requirements of the caller's saved Task executions. Ready Tasks require resume_consultation_task. Cancellation alone never resumes. Read current conclusions, requirements and PR/SHA before continuing.",
    inputSchema: { projectId: z.string() },
  }, ({ projectId }) => asPrincipal((principalId) => coordination.reconcileConsultationWaits(principalId, projectId)));
  server.registerTool("resume_consultation_task", {
    title: "Resume Consultation Task",
    description: "Reacquire the saved execution phase Claim after checking every Consultation and the actual persisted worktree/Context, PR, HEAD and source fingerprint. Only the original Principal/Role can resume. Never resubmit an old blocked result.",
    inputSchema: { taskId: z.string(), runtime, requestId: requestIdSchema },
  }, ({ taskId, runtime: savedRuntime, requestId }) => asPrincipal((principalId) => coordination.resumeConsultationTask(principalId, taskId, savedRuntime, requestId)));
  server.registerTool("confirm_consultation_continuation", {
    title: "Confirm Consultation Continuation",
    description: "Manager only. Confirm cancellation reasons and current continuation policy against the current Task requirementVersion and every Consultation revision. Does not replace resolution of open Consultations.",
    inputSchema: { taskId: z.string(), expectedRequirementVersion: z.string(), consultationRevisions: z.array(z.object({ id: z.string(), revision: z.number().int() })), reason: z.string(), requestId: requestIdSchema },
  }, ({ taskId, expectedRequirementVersion, consultationRevisions, reason, requestId }) => asPrincipal((principalId) => coordination.confirmConsultationContinuation(principalId, taskId, expectedRequirementVersion, consultationRevisions, reason, requestId)));

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
    "get_outcome_handoff_context",
    {
      title: "Get Outcome Handoff Context",
      description:
        "Read what a Manager needs to plan the handoff of an Outcome to this Project: the Outcome (title, description, hypothesis, " +
        "status, origin Decision, fixed Success Criteria), the default correlationId, the current Constraints of the Project's Workspace " +
        "and the Project's Repositories. Requires a manager Grant in the Project; no Workspace Grant is needed or used. " +
        "NOT_FOUND if the Outcome is not in the Project's Workspace, CONFLICT with reason not_target_project if this Project is not " +
        "a Target of the Outcome. A cancelled Outcome is returned with its status, but issue_story rejects it.",
      inputSchema: { projectId: z.string().min(1), outcomeId: z.string().min(1) },
    },
    ({ projectId, outcomeId }) =>
      asPrincipal((principalId) => coordination.getOutcomeHandoffContext(principalId, projectId, outcomeId)),
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
    "list_task_pull_requests",
    {
      title: "List Task Pull Requests",
      description:
        "List the GitHub pull requests registered to a Task with the facts the server verified on GitHub (number, URL, state, " +
        "draft, head branch/SHA, base branch, merge SHA, author) and verifiedAt, in registration order. current marks the latest. " +
        "Deliverable or comment URLs are not verified pull requests and are not listed. Requires any Role Grant in the Task's Project.",
      inputSchema: { taskId: z.string().min(1) },
    },
    ({ taskId }) => asPrincipal((principalId) => coordination.listTaskPullRequests(principalId, taskId)),
  );
  server.registerTool(
    "register_task_pull_request",
    {
      title: "Register Task Pull Request",
      description:
        "Worker with the current Work Claim of a doing Task only. The server reads the pull request from GitHub and attaches it " +
        "when it is an open, non-draft PR of the given Project Repository (https://github.com/{owner}/{name}, the Story's " +
        "Repository if set) and not registered to another Task. Re-registering the same PR refreshes its verified facts; another " +
        "PR needs the current open PR closed first. GITHUB_UNAVAILABLE (retryable) means GitHub could not be read and nothing was " +
        "recorded; GITHUB_ACCESS_DENIED / PULL_REQUEST_NOT_FOUND / PULL_REQUEST_NOT_READY are definitive. After a lost response, " +
        "resend the same input and requestId (returns the recorded result without reading GitHub) or check list_task_pull_requests.",
      inputSchema: {
        taskId: z.string().min(1),
        claimId: claimIdSchema,
        repositoryId: z.string().min(1).describe("Repository ID registered in the Task's Project"),
        number: z.number().int().positive().describe("GitHub pull request number"),
        requestId: requestIdSchema,
      },
    },
    ({ requestId, ...input }) =>
      asPrincipal((principalId) => coordination.registerTaskPullRequest(principalId, input, requestId)),
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
        "Success Criteria, its origin Decision and the current Constraints of the Project's Workspace into the Story. The Outcome is " +
        "read in the Workspace the Project belongs to and the Project must be one of its Target Projects (NOT_FOUND if the Outcome is " +
        "not in that Workspace, CONFLICT if it is not active or, with reason not_target_project, if this Project is not a Target). " +
        "One Outcome may have a Story in each of its Target Projects. repositoryId (a Repository registered on the Project) records the target " +
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
        "Acquire an acceptance Claim. An in_review Task is atomically moved to wait_accept as a Manager direct review, except a Task " +
        "with a registered pull request, which must first pass reviewed_task (PULL_REQUEST_NOT_READY).",
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
      description:
        "Complete work under the current Claim and move the Task to in_review. For a Task with a registered pull request, the server " +
        "re-reads the current PR on GitHub and requires an open, non-draft PR registered under this Work Claim (re-register the same PR " +
        "with register_task_pull_request after a new Claim); its current head is recorded for review. Tasks without a pull request keep " +
        "the plain path. Failures return error.details (operation, taskId, pullRequest, states/SHAs, recheck).",
      inputSchema: { taskId: z.string().min(1), claimId: claimIdSchema, requestId: requestIdSchema },
    },
    ({ taskId, claimId, requestId }) =>
      asPrincipal((principalId) => coordination.completeTask(principalId, taskId, claimId, requestId)),
  );
  server.registerTool(
    "reviewed_task",
    {
      title: "Reviewed Task",
      description:
        "Approve implementation under the current Review Claim. For a Task with a registered pull request: review the PR head, post a PR " +
        "comment containing <!-- compass-task-review: {\"taskId\":\"…\",\"claimId\":\"<this Review Claim>\",\"headSha\":\"<reviewed head>\"," +
        "\"decision\":\"approve\"} --> (a GitHub Approve is not required; the same GitHub account as the Worker may post it), merge the PR " +
        "on GitHub at that head, then call this with expectedHeadSha and reviewCommentId. The server verifies on GitHub that the PR is " +
        "merged at expectedHeadSha, the comment matches this Task/Claim/head, and the Repository's requiredChecks (none = CI not " +
        "required) succeeded on that head. A failed or conflicting merge, a new head, a closed PR or failing checks are rejected with " +
        "error.details (operation, taskId, pullRequest, SHAs, state, recheck); nothing is recorded.",
      inputSchema: {
        taskId: z.string().min(1),
        claimId: claimIdSchema,
        expectedHeadSha: z.string().regex(/^[a-fA-F0-9]{40}$/).optional().describe("Full head SHA you reviewed (Tasks with a pull request)"),
        reviewCommentId: z.number().int().positive().optional().describe("GitHub comment ID of your review marker (Tasks with a pull request)"),
        requestId: requestIdSchema,
      },
    },
    ({ taskId, claimId, requestId, expectedHeadSha, reviewCommentId }) =>
      asPrincipal((principalId) => coordination.reviewedTask(principalId, taskId, claimId, requestId, { expectedHeadSha, reviewCommentId })),
  );
  server.registerTool(
    "accept_task",
    {
      title: "Accept Task",
      description:
        "Accept a wait_accept Task under the current Acceptance Claim. Optional deliverables record the acceptance evidence you " +
        "verified: [{ repositoryId (registered in the Task's Project), commitSha (full 40-character SHA of the accepted change, e.g. " +
        "the merge commit), paths (Repository-relative files changed), pullRequestUrl ({Repository URL}/pull/{number}, or null; " +
        "must be null for a Repository without an http(s) URL) }]. They are kept on the TASK_ACCEPTED change as references only; " +
        "record_consultation_artifact accepts only a path / commit / PR that matches them. For a Task with a registered pull request, " +
        "verification { mergeSha, evidence } is required: check the AC against the merge commit of the reviewed head (list_task_pull_requests " +
        "current.mergeSha) and give per-criterion evidence; the server re-reads GitHub and accepts only when the PR is merged at the head " +
        "verified by reviewed_task and mergeSha matches. Otherwise error.details states what differs and how to recheck.",
      inputSchema: {
        taskId: z.string().min(1),
        claimId: claimIdSchema,
        deliverables: z
          .array(z.object({ repositoryId: z.string(), commitSha: z.string(), paths: z.array(z.string()), pullRequestUrl: z.string().nullable().optional() }))
          .optional(),
        verification: z
          .object({ mergeSha: z.string().regex(/^[a-fA-F0-9]{40}$/), evidence: z.string().trim().min(1).max(10_000) })
          .optional()
          .describe("Tasks with a pull request: the merge SHA you verified and the acceptance evidence"),
        requestId: requestIdSchema,
      },
    },
    ({ taskId, claimId, deliverables, verification, requestId }) =>
      asPrincipal((principalId) => coordination.acceptTask(principalId, taskId, claimId, requestId, deliverables, verification)),
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
  server.registerTool(
    "record_publication",
    {
      title: "Record Publication",
      description:
        "For an external Runtime (CD, deploy notification or liveness check): record that a revision of a Repository registered on the " +
        "Project was confirmed as published at a target. The same contract is used for every deploy method: repositoryId, revision (full " +
        "40-character commit SHA), target (a publication target reference such as production, up to 100 characters), targetUrl (optional " +
        "http/https URL without credentials), method (optional label such as cloudflare-pages, not used for decisions), observedAt (epoch " +
        "ms when the Runtime confirmed it, not in the future) and evidence (1-20 references { kind: deployment | ci | url, uri }; never " +
        "content). The record is kept as an append-only raw record. Whether each change (a Task's merged pull request or accepted " +
        "deliverable commit) is contained in the revision is decided by Compass from the GitHub history (compare), not from the Runtime; " +
        "a revision missing from the Repository fails with VALIDATION_ERROR and GITHUB_UNAVAILABLE (retryable) records nothing. " +
        "Resending the same repositoryId, target, revision and observedAt returns the same record (recorded false); different content for " +
        "them fails with CONFLICT. An older observedAt than the target's latest record is kept but does not change the current status " +
        "(superseded true). A merged pull request or an accepted Task is never treated as published without a record. " +
        "Requires a Runtime Credential (Authorization: Bearer cmp_runtime...) of the Project with the publication:write scope; in " +
        "trusted-local mode Bearer <RuntimeName> with a runtime Grant is also accepted (UNAUTHENTICATED / FORBIDDEN otherwise).",
      inputSchema: {
        projectId: z.string().min(1),
        repositoryId: z.string().min(1),
        revision: z.string(),
        target: z.string(),
        targetUrl: z.string().nullable().optional(),
        method: z.string().nullable().optional(),
        observedAt: z.number(),
        evidence: z.array(z.object({ kind: z.string(), uri: z.string() })),
      },
      _meta: runtimeToolMeta,
    },
    ({ projectId, ...input }) => execute(() => services.recordPublicationUseCase.execute(caller, projectId, input)),
  );
};
