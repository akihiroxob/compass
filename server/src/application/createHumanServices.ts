import { AgentContextService } from "./agentContext/AgentContextService.ts";
import {
  AbandonIntentUseCase,
  CancelOutcomeUseCase,
  CreateIntentUseCase,
  CreateOutcomeUseCase,
  GetExecutionSummaryUseCase,
  GetIntentUseCase,
  GetOutcomeUseCase,
  GetResearchRequestUseCase,
  ListIntentRevisionsUseCase,
  ListAdrReferencesUseCase,
  ListDirectionDecisionsUseCase,
  ListIntentExplanationsUseCase,
  ListIntentMetricsUseCase,
  ListIntentsUseCase,
  ListOutcomeEvaluationsUseCase,
  ListOutcomeTargetProjectsUseCase,
  ListOutcomeTargetExecutionsUseCase,
  ListOutcomeTargetWorkUseCase,
  ListWorkspaceOutcomesUseCase,
  GetWorkspaceOutcomeOverviewUseCase,
  ListOutcomesUseCase,
  ListResearchRequestsUseCase,
  UpdateIntentUseCase,
  UpdateOutcomeUseCase,
} from "@compass/direction";
import {
  ArchiveProjectUseCase,
  ArchiveWorkspaceUseCase,
  CreateWorkspaceProjectUseCase,
  CreateWorkspaceUseCase,
  GetProjectUseCase,
  GetWorkspaceUseCase,
  ListProjectsUseCase,
  ListWorkspacesUseCase,
  ListWorkspaceProjectsUseCase,
  UpdateProjectUseCase,
  UpdateWorkspaceUseCase,
} from "@compass/organization";
import {
  AcceptExecutionTaskUseCase,
  AddExecutionTaskCommentUseCase,
  CancelExecutionTaskUseCase,
  CreateExecutionStoryUseCase,
  CreateExecutionTaskUseCase,
  EditExecutionStoryUseCase,
  EditExecutionTaskUseCase,
  GetExecutionTaskUseCase,
  ListExecutionUseCase,
  SearchExecutionWorkUseCase,
  ListProjectReleasesUseCase,
  ListRecentExecutionChangesUseCase,
  RejectExecutionTaskUseCase,
  TaskCoordinationService,
} from "@compass/work";
import {
  GetHumanProjectUseCase,
  GrantWorkspaceRoleUseCase,
  RevokeWorkspaceRoleUseCase,
  ListWorkspaceGrantsUseCase,
  ListWorkspaceAgentRunsUseCase,
  GrantProjectRoleUseCase,
  HumanAuthorizedUseCase,
  HumanOperatorUseCase,
  HumanProjectAuthorizationService,
  ListHumanProjectsUseCase,
  ListProjectGrantsUseCase,
  RevokeProjectRoleUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  CreateHumanWorkspaceProjectUseCase,
  GetHumanWorkspaceUseCase,
  HumanWorkspaceAuthorizationService,
  HumanWorkspaceAuthorizedUseCase,
  ListHumanWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  RevokeWorkspaceMemberUseCase,
  executionRoles,
  humanOperatorPrincipalId,
  workspaceRoles,
  type HumanActor,
  type HumanProjectOperation,
  type HumanWorkspaceOperation,
  type ProjectRole,
} from "@compass/access";
import { GetActivityUseCase, ListActivitiesUseCase, ListWorkspaceActivityStreamUseCase } from "@compass/activity";
import {
  AcquireConsultationLeaseUseCase,
  AddConsultationMessageUseCase,
  CancelConsultationUseCase,
  CreateConsultationUseCase,
  GetConsultationUseCase,
  GetConsultationHandoffContextUseCase,
  HandOffConsultationUseCase,
  ListAccessibleConsultationsUseCase,
  ListConsultationsUseCase,
  RecordConsultationArtifactUseCase,
  RequestConsultationFollowupUseCase,
  ResolveConsultationUseCase,
  type ConsultationActor,
  type ConsultationScope,
} from "@compass/collaboration";
import { NotFoundError } from "@compass/shared";
import type { ActivityActorContext } from "./activityActor.ts";
import type { ProjectRepository, WorkspaceRepository } from "@compass/organization";
import type { WorkspaceMembershipRepository } from "@compass/access";
export interface HumanServiceOperations {
  listProjectsUseCase: ListProjectsUseCase;
  getProjectUseCase: GetProjectUseCase;
  updateProjectUseCase: Pick<UpdateProjectUseCase, "execute">;
  archiveProjectUseCase: Pick<ArchiveProjectUseCase, "execute">;
  createIntentUseCase: Pick<CreateIntentUseCase, "execute">;
  listIntentsUseCase: Pick<ListIntentsUseCase, "execute">;
  getIntentUseCase: Pick<GetIntentUseCase, "execute">;
  listIntentRevisionsUseCase: Pick<ListIntentRevisionsUseCase, "execute">;
  updateIntentUseCase: Pick<UpdateIntentUseCase, "execute">;
  abandonIntentUseCase: Pick<AbandonIntentUseCase, "execute">;
  createOutcomeUseCase: Pick<CreateOutcomeUseCase, "execute">;
  listOutcomesUseCase: Pick<ListOutcomesUseCase, "execute">;
  getOutcomeUseCase: Pick<GetOutcomeUseCase, "execute">;
  updateOutcomeUseCase: Pick<UpdateOutcomeUseCase, "execute">;
  cancelOutcomeUseCase: Pick<CancelOutcomeUseCase, "execute">;
  listResearchRequestsUseCase: Pick<ListResearchRequestsUseCase, "execute">;
  getResearchRequestUseCase: Pick<GetResearchRequestUseCase, "execute">;
  listDirectionDecisionsUseCase: Pick<ListDirectionDecisionsUseCase, "execute">;
  listIntentMetricsUseCase: Pick<ListIntentMetricsUseCase, "execute">;
  listIntentExplanationsUseCase: Pick<ListIntentExplanationsUseCase, "execute">;
  listAdrReferencesUseCase: Pick<ListAdrReferencesUseCase, "execute">;
  listOutcomeEvaluationsUseCase: Pick<ListOutcomeEvaluationsUseCase, "execute">;
  listOutcomeTargetProjectsUseCase: Pick<ListOutcomeTargetProjectsUseCase, "execute">;
  listOutcomeTargetWorkUseCase: Pick<ListOutcomeTargetWorkUseCase, "execute">;
  listWorkspaceOutcomesUseCase: Pick<ListWorkspaceOutcomesUseCase, "execute">;
  getWorkspaceOutcomeOverviewUseCase: Pick<GetWorkspaceOutcomeOverviewUseCase, "execute">;
  listOutcomeTargetExecutionsUseCase: Pick<ListOutcomeTargetExecutionsUseCase, "execute">;
  listWorkspaceGrantsUseCase: Pick<ListWorkspaceGrantsUseCase, "execute">;
  listWorkspaceAgentRunsUseCase: Pick<ListWorkspaceAgentRunsUseCase, "execute">;
  grantWorkspaceRoleUseCase: Pick<GrantWorkspaceRoleUseCase, "execute">;
  revokeWorkspaceRoleUseCase: Pick<RevokeWorkspaceRoleUseCase, "execute">;
  grantProjectRoleUseCase: Pick<GrantProjectRoleUseCase, "execute">;
  revokeProjectRoleUseCase: Pick<RevokeProjectRoleUseCase, "execute">;
  listProjectGrantsUseCase: Pick<ListProjectGrantsUseCase, "execute">;
  getExecutionSummaryUseCase: { execute(projectId: string, outcomeId: string): ReturnType<GetExecutionSummaryUseCase["execute"]> };
  listExecutionUseCase: Pick<ListExecutionUseCase, "execute">;
  searchExecutionWorkUseCase: Pick<SearchExecutionWorkUseCase, "execute">;
  getExecutionTaskUseCase: Pick<GetExecutionTaskUseCase, "execute">;
  listRecentExecutionChangesUseCase: Pick<ListRecentExecutionChangesUseCase, "execute">;
}

export interface HumanServicesDependencies {
  services: HumanServiceOperations;
  humanProjectAuthorizationService: HumanProjectAuthorizationService;
  humanWorkspaceAuthorizationService: HumanWorkspaceAuthorizationService;
  activityActorContext: ActivityActorContext;
  agentContextService: AgentContextService;
  taskCoordinationService: TaskCoordinationService;
  projectRepository: ProjectRepository;
  workspaceRepository: WorkspaceRepository;
  workspaceMembershipRepository: WorkspaceMembershipRepository;
  listActivitiesUseCase: ListActivitiesUseCase;
  getActivityUseCase: GetActivityUseCase;
  listWorkspaceActivitiesUseCase: ListActivitiesUseCase;
  getWorkspaceActivityUseCase: GetActivityUseCase;
  listWorkspaceActivityStreamUseCase: ListWorkspaceActivityStreamUseCase;
  listProjectReleasesUseCase: ListProjectReleasesUseCase;
  consultations: { create: CreateConsultationUseCase; list: ListConsultationsUseCase; listAccessible: ListAccessibleConsultationsUseCase; get: GetConsultationUseCase; acquireLease: AcquireConsultationLeaseUseCase; addMessage: AddConsultationMessageUseCase; resolve: ResolveConsultationUseCase; cancel: CancelConsultationUseCase; handOff: HandOffConsultationUseCase; getHandoffContext: GetConsultationHandoffContextUseCase; requestFollowup: RequestConsultationFollowupUseCase; recordArtifact: RecordConsultationArtifactUseCase };
}

/** 相談のscope。ProjectとWorkspaceは別のscopeで、互いのIDで指しても相談は見つからない。 */
const projectConsultationScope = (projectId: string): ConsultationScope => ({ kind: "project", projectId });
const workspaceConsultationScope = (workspaceId: string): ConsultationScope => ({ kind: "workspace", workspaceId });

/** Agentが担うRole（Workspace Direction Role・Project Execution Role）。RuntimeはCredential scopeのため含めない。 */
const isAgentRole = (role: string): role is ProjectRole => [...workspaceRoles, ...executionRoles].some((candidate) => candidate === role);
export const createHumanServices = (dependencies: HumanServicesDependencies) => {
  const { services, humanProjectAuthorizationService, humanWorkspaceAuthorizationService, activityActorContext, agentContextService, taskCoordinationService, projectRepository, workspaceRepository, workspaceMembershipRepository, listActivitiesUseCase, getActivityUseCase, listWorkspaceActivitiesUseCase, getWorkspaceActivityUseCase, listWorkspaceActivityStreamUseCase, listProjectReleasesUseCase, consultations } = dependencies;
  const authorized = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, ...args: Args): Promise<Result> },
  ) => new HumanAuthorizedUseCase(humanProjectAuthorizationService, operation, useCase);
  const operator = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, operatorPrincipalId: string, ...args: Args): Promise<Result> },
  ) => new HumanOperatorUseCase(humanProjectAuthorizationService, operation, useCase);
  // Projectの変更。canonical Activityの操作者を認証済みHuman（`human:{humanUserId}`、立場operator）に固定する。
  const asOperator = <Args extends unknown[], Result>(
    inner: { execute(actor: HumanActor, scopeId: string, ...args: Args): Promise<Result> },
  ) => ({
    execute: (actor: HumanActor, scopeId: string, ...args: Args) =>
      activityActorContext.run({ principalId: humanOperatorPrincipalId(actor), role: "operator" }, () =>
        inner.execute(actor, scopeId, ...args),
      ),
  });
  const directionWrite = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, ...args: Args): Promise<Result> },
  ) => asOperator(authorized(operation, useCase));
  const workspaceAuthorized = <Args extends unknown[], Result>(
    operation: HumanWorkspaceOperation,
    useCase: { execute(workspaceId: string, ...args: Args): Promise<Result> },
  ) => new HumanWorkspaceAuthorizedUseCase(humanWorkspaceAuthorizationService, operation, useCase);
  // Workspace Directionの変更（Workspace Membershipのeditor以上）。操作者はProjectの変更と同じくHuman operator。
  const workspaceDirectionWrite = <Args extends unknown[], Result>(
    useCase: { execute(workspaceId: string, ...args: Args): Promise<Result> },
  ) => asOperator(workspaceAuthorized("direction.write", useCase));
  // 相談へのHumanの記録。scopeのMembershipで認可し、記録主体を認証済みHuman（`human:{humanUserId}`、立場operator）に固定する。
  const humanConsultation = <Args extends unknown[], Result>(
    authorize: (actor: HumanActor, scopeId: string) => Promise<unknown>,
    toScope: (scopeId: string) => ConsultationScope,
    useCase: { execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, ...args: Args): Promise<Result> },
  ) => ({
    execute: async (actor: HumanActor, scopeId: string, consultationId: string, ...args: Args): Promise<Result> => {
      await authorize(actor, scopeId);
      return useCase.execute(toScope(scopeId), consultationId, { kind: "human", principalId: humanOperatorPrincipalId(actor), role: "operator" }, ...args);
    },
  });
  const projectConsultation = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, ...args: Args): Promise<Result> },
  ) => humanConsultation((actor, projectId) => humanProjectAuthorizationService.authorize(actor, projectId, operation), projectConsultationScope, useCase);
  const workspaceConsultation = <Args extends unknown[], Result>(
    operation: HumanWorkspaceOperation,
    useCase: { execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, ...args: Args): Promise<Result> },
  ) => humanConsultation((actor, workspaceId) => humanWorkspaceAuthorizationService.authorize(actor, workspaceId, operation), workspaceConsultationScope, useCase);
  // 相談の参照（scopeのIDを相談のscopeへ変換する）。認可は`authorized` / `workspaceAuthorized`が行う。
  const consultationReads = (toScope: (scopeId: string) => ConsultationScope) => ({
    list: { execute: (scopeId: string, query: unknown) => consultations.list.execute(toScope(scopeId), query) },
  });
  const projectConsultationReads = consultationReads(projectConsultationScope);
  const workspaceConsultationReads = consultationReads(workspaceConsultationScope);
  // Project相談の文書反映はそのProject自身の依頼だけ。Workspace相談の文書反映は、HumanがWorkspace Membershipを持つWorkspaceの
  // Projectの分だけ展開する（ADR 0003）。
  const getProjectConsultation = {
    execute: (projectId: string, consultationId: string) => consultations.get.execute(projectConsultationScope(projectId), consultationId, [projectId]),
  };
  const getWorkspaceConsultation = {
    execute: async (actor: HumanActor, workspaceId: string, consultationId: string) => {
      await humanWorkspaceAuthorizationService.authorize(actor, workspaceId, "workspace.read");
      const readableProjectIds = await humanProjectAuthorizationService.listReadableProjectIds(actor);
      return consultations.get.execute(workspaceConsultationScope(workspaceId), consultationId, readableProjectIds);
    },
  };
  // Human向けWeb APIの入口。Membershipの認可（domainの権限表）を通してから、MCPと共通のuse caseへ委譲する。
  // Runtime向け（runtime-events・execution-evidence）はHuman向けではないため含めない。
  const human = {
    listProjects: new ListHumanProjectsUseCase(services.listProjectsUseCase, humanProjectAuthorizationService),
    getProject: new GetHumanProjectUseCase(humanProjectAuthorizationService, services.getProjectUseCase),
    updateProject: directionWrite("project.update", services.updateProjectUseCase),
    archiveProject: directionWrite("project.archive", services.archiveProjectUseCase),
    // Workspace Direction（Workspace Membershipで認可）。archivedのWorkspaceも参照でき、変更はuse caseが拒否する。
    createIntent: workspaceDirectionWrite(services.createIntentUseCase),
    listIntents: workspaceAuthorized("workspace.read", services.listIntentsUseCase),
    getIntent: workspaceAuthorized("workspace.read", services.getIntentUseCase),
    listIntentRevisions: workspaceAuthorized("workspace.read", services.listIntentRevisionsUseCase),
    updateIntent: workspaceDirectionWrite(services.updateIntentUseCase),
    abandonIntent: workspaceDirectionWrite(services.abandonIntentUseCase),
    createOutcome: workspaceDirectionWrite(services.createOutcomeUseCase),
    listOutcomes: workspaceAuthorized("workspace.read", services.listOutcomesUseCase),
    getOutcome: workspaceAuthorized("workspace.read", services.getOutcomeUseCase),
    updateOutcome: workspaceDirectionWrite(services.updateOutcomeUseCase),
    cancelOutcome: workspaceDirectionWrite(services.cancelOutcomeUseCase),
    listResearchRequests: workspaceAuthorized("workspace.read", services.listResearchRequestsUseCase),
    getResearchRequest: workspaceAuthorized("workspace.read", services.getResearchRequestUseCase),
    listDirectionDecisions: workspaceAuthorized("workspace.read", services.listDirectionDecisionsUseCase),
    listIntentMetrics: workspaceAuthorized("workspace.read", services.listIntentMetricsUseCase),
    listIntentExplanations: workspaceAuthorized("workspace.read", services.listIntentExplanationsUseCase),
    listAdrReferences: workspaceAuthorized("workspace.read", services.listAdrReferencesUseCase),
    listOutcomeEvaluations: workspaceAuthorized("workspace.read", services.listOutcomeEvaluationsUseCase),
    listOutcomeTargetProjects: workspaceAuthorized("workspace.read", services.listOutcomeTargetProjectsUseCase),
    listOutcomeTargetWork: workspaceAuthorized("workspace.read", services.listOutcomeTargetWorkUseCase),
    listWorkspaceOutcomes: workspaceAuthorized("workspace.read", services.listWorkspaceOutcomesUseCase),
    getWorkspaceOutcomeOverview: workspaceAuthorized("workspace.read", services.getWorkspaceOutcomeOverviewUseCase),
    listOutcomeTargetExecutions: workspaceAuthorized("workspace.read", services.listOutcomeTargetExecutionsUseCase),
    // Workspace Activity閲覧（Workspace Membership）。所属ProjectのActivityは含めず、Web UIからは記録しない。
    listWorkspaceActivities: workspaceAuthorized("workspace.read", listWorkspaceActivitiesUseCase),
    getWorkspaceActivity: workspaceAuthorized("workspace.read", getWorkspaceActivityUseCase),
    listWorkspaceActivityStream: workspaceAuthorized("workspace.read", listWorkspaceActivityStreamUseCase),
    // Workspace Direction Role（strategist / researcher / evaluator）のAgent Grant（Workspace Membership）。Project Grantは含めず、
    // Project Grantからは継承しない。付与・取消はadministrator以上。
    listWorkspaceGrants: workspaceAuthorized("grant.read", services.listWorkspaceGrantsUseCase),
    // Agentの実行観測（Workspaceとactiveな所属Project）。Workspace Membership（viewer以上）で読む。記録はMCPだけ。
    listWorkspaceAgentRuns: workspaceAuthorized("workspace.read", services.listWorkspaceAgentRunsUseCase),
    grantWorkspaceRole: workspaceAuthorized("grant.manage", services.grantWorkspaceRoleUseCase),
    revokeWorkspaceRole: workspaceAuthorized("grant.manage", services.revokeWorkspaceRoleUseCase),
    grantProjectRole: authorized("grant.manage", services.grantProjectRoleUseCase),
    revokeProjectRole: authorized("grant.manage", services.revokeProjectRoleUseCase),
    listProjectGrants: authorized("grant.read", services.listProjectGrantsUseCase),
    // Role DefinitionとRoleが参照するSkillのmetadata（Git管理の資産。MCPの`get_role_instructions`・`list_skills`と同じ内容）。
    // 認証済みHumanであれば読め、Grantの有無を問わない。Agent Roleだけを受け付け、Runtime（Credential scope）は対象外。
    getAgentRole: {
      execute: async (_actor: HumanActor, role: string) => {
        if (!isAgentRole(role)) throw new NotFoundError(`Agent Role ${role} was not found`);
        const { role: definition, skills, source } = await agentContextService.getRoleAssets(role);
        return { role: { name: definition.name, path: definition.path, content: definition.content }, skills, source };
      },
    },
    // Execution SummaryはProject固有の記録で、所属WorkspaceのMembership（viewer以上）で読む。
    getExecutionSummary: authorized("project.read", services.getExecutionSummaryUseCase),
    // Execution閲覧（Task 45）。archivedのProjectも参照できる（介入はTask 46の`execution.intervene`）。
    listExecution: authorized("project.read", services.listExecutionUseCase),
    searchExecutionWork: authorized("project.read", services.searchExecutionWorkUseCase),
    getExecutionTask: authorized("project.read", services.getExecutionTaskUseCase),
    listRecentExecutionChanges: authorized("project.read", services.listRecentExecutionChangesUseCase),
    // リリース履歴（開発の受入と公開確認を別の項目で返す）。archivedのProjectも参照できる。公開記録の入力はRuntimeだけ。
    listProjectReleases: authorized("project.read", listProjectReleasesUseCase),
    // Activity閲覧。archivedのProjectも参照できる。記録はAgentのMCP（record_activity）とcanonical生成だけで、Web UIからは記録しない。
    listActivities: authorized("project.read", listActivitiesUseCase),
    getActivity: authorized("project.read", getActivityUseCase),
    // Execution介入（Task 46。U3）。Web UI専用で、MCPへは公開しない（Agentは既存のClaim・review・accept toolを使う）。
    acceptExecutionTask: operator("execution.intervene", new AcceptExecutionTaskUseCase(taskCoordinationService)),
    rejectExecutionTask: operator("execution.intervene", new RejectExecutionTaskUseCase(taskCoordinationService)),
    cancelExecutionTask: operator("execution.intervene", new CancelExecutionTaskUseCase(taskCoordinationService)),
    addExecutionTaskComment: operator("execution.intervene", new AddExecutionTaskCommentUseCase(taskCoordinationService)),
    // Story・Taskの手動起票・編集（Task 47。U4）。Web UI専用で、MCPへは公開しない（Agentは既存のissue_* / edit_* toolを使う）。
    createExecutionStory: operator("execution.plan", new CreateExecutionStoryUseCase(taskCoordinationService)),
    editExecutionStory: operator("execution.plan", new EditExecutionStoryUseCase(taskCoordinationService)),
    createExecutionTask: operator("execution.plan", new CreateExecutionTaskUseCase(taskCoordinationService)),
    editExecutionTask: operator("execution.plan", new EditExecutionTaskUseCase(taskCoordinationService)),
    // Project相談（判断待ち）。参照はviewer以上、返信はeditor以上、明示決定・取消はadministrator以上。相談の作成はAgentのMCPだけ。
    // 明示決定は`human_decision`として記録し、MCPへは公開しない（AgentはHumanの返信を根拠に`agent_summary`を記録する）。
    listConsultations: authorized("project.read", projectConsultationReads.list),
    getConsultation: authorized("project.read", getProjectConsultation),
    replyConsultation: projectConsultation("consultation.reply", consultations.addMessage),
    decideConsultation: projectConsultation("consultation.decide", consultations.resolve),
    cancelConsultation: projectConsultation("consultation.decide", consultations.cancel),
    // Workspace相談。Workspace Membershipで認可する（参照viewer・返信editor・明示決定/取消administrator以上）。
    listWorkspaceConsultations: workspaceAuthorized("workspace.read", workspaceConsultationReads.list),
    getWorkspaceConsultation,
    replyWorkspaceConsultation: workspaceConsultation("consultation.reply", consultations.addMessage),
    decideWorkspaceConsultation: workspaceConsultation("consultation.decide", consultations.resolve),
    cancelWorkspaceConsultation: workspaceConsultation("consultation.decide", consultations.cancel),
    // 横断した判断待ち一覧。有効なWorkspace Membershipを持つWorkspaceと、その配下Projectの相談だけを選ぶ（ADR 0003）。
    // 絞り込み・ページングはこの認可済みの集合に対して行う。
    listAccessibleConsultations: {
      execute: async (actor: HumanActor, query: unknown) =>
        consultations.listAccessible.execute({
          projectIds: await humanProjectAuthorizationService.listReadableProjectIds(actor),
          workspaceIds: await workspaceMembershipRepository.listActiveWorkspaceIds(actor.humanUserId),
        }, query),
    },
    // Workspace（Workspace Membershipで認可）。作成・参照・更新・archive・既存WorkspaceへのProject作成はWeb APIへ接続済み。
    // 作成は認証済みであればよく、作成者を同一transactionでowner Membershipにする。
    createWorkspace: new CreateWorkspaceUseCase(workspaceRepository),
    listWorkspaces: new ListHumanWorkspacesUseCase(new ListWorkspacesUseCase(workspaceRepository), workspaceMembershipRepository),
    getWorkspace: new GetHumanWorkspaceUseCase(humanWorkspaceAuthorizationService, new GetWorkspaceUseCase(workspaceRepository)),
    // 所属Projectのpurpose・Resource参照。Project詳細・Workも同じWorkspace Membershipで、操作別のRole水準を検査する。
    listWorkspaceProjects: workspaceAuthorized(
      "workspace.read",
      new ListWorkspaceProjectsUseCase(workspaceRepository, projectRepository),
    ),
    updateWorkspace: workspaceAuthorized("workspace.update", new UpdateWorkspaceUseCase(workspaceRepository)),
    archiveWorkspace: workspaceAuthorized("workspace.archive", new ArchiveWorkspaceUseCase(workspaceRepository)),
    createWorkspaceProject: new CreateHumanWorkspaceProjectUseCase(
      humanWorkspaceAuthorizationService,
      new CreateWorkspaceProjectUseCase(projectRepository),
    ),
    // Workspace member管理（一覧はviewer以上、Role変更・除外はowner）。配下の全Projectへの次の操作から反映される。
    listWorkspaceMembers: new ListWorkspaceMembersUseCase(humanWorkspaceAuthorizationService, workspaceMembershipRepository),
    changeWorkspaceMemberRole: new ChangeWorkspaceMemberRoleUseCase(
      humanWorkspaceAuthorizationService,
      workspaceMembershipRepository,
    ),
    revokeWorkspaceMember: new RevokeWorkspaceMemberUseCase(humanWorkspaceAuthorizationService, workspaceMembershipRepository),
  };
  return human;
};
