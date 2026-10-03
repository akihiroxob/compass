import { AgentContextService } from "../application/agentContext/AgentContextService.ts";
import { GetRoleContextUseCase } from "../application/agentContext/GetRoleContextUseCase.ts";
import { FileAgentAssetRepository } from "../infrastructure/agentAssets/FileAgentAssetRepository.ts";
import {
  AbandonIntentUseCase,
  AckRuntimeEventUseCase,
  ArchiveProjectUseCase,
  CancelOutcomeUseCase,
  CancelResearchRequestUseCase,
  CompleteResearchRequestUseCase,
  CreateAdrHandoffRequestUseCase,
  CreateDirectionDecisionUseCase,
  CreateIntentUseCase,
  CreateOutcomeUseCase,
  CreateProjectUseCase,
  CreateResearchRequestUseCase,
  DecideNextOutcomeUseCase,
  DirectionReferenceLookupService,
  FetchRuntimeEventsUseCase,
  GetEvaluatorContextUseCase,
  GetExecutionSummaryUseCase,
  GetIntentUseCase,
  GetOutcomeUseCase,
  GetProjectUseCase,
  GetResearcherContextUseCase,
  GetResearchRequestUseCase,
  GetStrategistContextUseCase,
  ListAdrReferencesUseCase,
  ListDirectionDecisionsUseCase,
  ListIntentsUseCase,
  ListOutcomeEvaluationsUseCase,
  ListOutcomesUseCase,
  ListProjectsUseCase,
  ListResearchRequestsUseCase,
  ListRuntimeEventsUseCase,
  RecordAdrReferenceUseCase,
  RecordExecutionEvidenceUseCase,
  RecordOutcomeEvaluationUseCase,
  RegisterResearchResultUseCase,
  RegisterResearchSynthesisUseCase,
  SQLiteAdrHandoffRepository,
  SQLiteDirectionDecisionRepository,
  SQLiteIntentRepository,
  SQLiteOutcomeEvaluationRepository,
  SQLiteOutcomeExecutionRepository,
  SQLiteOutcomeRepository,
  SQLiteProjectRepository,
  SQLiteResearchRepository,
  SQLiteRuntimeEventRepository,
  UpdateIntentUseCase,
  UpdateOutcomeUseCase,
  UpdateProjectUseCase,
} from "@compass/direction";
import {
  AcceptExecutionTaskUseCase,
  AddExecutionTaskCommentUseCase,
  CancelExecutionTaskUseCase,
  CreateExecutionStoryUseCase,
  CreateExecutionTaskUseCase,
  EditExecutionStoryUseCase,
  EditExecutionTaskUseCase,
  ExecutionSummaryService,
  GetExecutionTaskUseCase,
  KyselyWorkStore,
  ListExecutionUseCase,
  ListRecentExecutionChangesUseCase,
  RejectExecutionTaskUseCase,
  TaskCoordinationService,
} from "@compass/work";
import {
  AuthenticateAccessCredentialUseCase,
  ChangeProjectMemberRoleUseCase,
  CompleteOidcLoginUseCase,
  CreateProjectInvitationUseCase,
  GetHumanAuthBootstrapStatusUseCase,
  GetHumanProjectUseCase,
  GrantProjectRoleUseCase,
  HumanAuthorizedUseCase,
  HumanOperatorUseCase,
  HumanProjectAuthorizationService,
  IssueAccessCredentialUseCase,
  ListAccessCredentialsUseCase,
  ListHumanProjectsUseCase,
  ListProjectGrantsUseCase,
  ListProjectInvitationsUseCase,
  ListProjectMembersUseCase,
  LocalDevLoginUseCase,
  ProjectAuthorizationService,
  RegisterOrLoginHumanUseCase,
  ResolveHumanSessionUseCase,
  RevokeAccessCredentialUseCase,
  RevokeHumanSessionUseCase,
  RevokeProjectInvitationUseCase,
  RevokeProjectMemberUseCase,
  RevokeProjectRoleUseCase,
  RotateAccessCredentialUseCase,
  RuntimeAuthorizationService,
  SQLiteAccessCredentialRepository,
  SQLiteHumanAccountRepository,
  SQLiteLoginAttemptRepository,
  SQLiteProjectGrantRepository,
  SQLiteProjectMembershipRepository,
  StartOidcLoginUseCase,
  type HumanIdentityProvider,
  type HumanProjectOperation,
  type ProjectRole,
} from "@compass/access";
import {
  AgentActivityReader,
  GetActivityUseCase,
  KyselyActivityStore,
  ListActivitiesUseCase,
  RecordActivityUseCase,
} from "@compass/activity";
import type { Kysely } from "kysely";
import { asAccessDatabase, asActivityDatabase, asDirectionDatabase, asWorkDatabase } from "./database/contextDatabase.ts";
import type { Database } from "./database/schema.ts";
import {
  accessProjectReaders,
  activityAuthorization,
  activityProjectReader,
  projectOwnerMembershipWriter,
  workChangeActivityObserver,
  workExternalReaders,
} from "../infrastructure/repository/contextAdapters.ts";

/** DBを開かずにUse Caseを組み立てる。containerはimport時にDBを開くため、CLIなどはこちらを使う。 */
export const createApplicationServices = (
  applicationDatabase: Kysely<Database>,
  /** Role・Policy・Skill・Knowledgeの配信。既定はrepo直下のGit管理資産を読む。 */
  agentContextService: AgentContextService = new AgentContextService(new FileAgentAssetRepository()),
  /** Researchの期限判定・Runtime event ackの記録時刻の時刻源。テストで固定できるよう注入する。 */
  clock: () => number = Date.now,
  /**
   * Human認証の設定。初期owner emailはplatform owner作成前の登録判定にだけ使う。
   * `identityProvider`はOIDC（Google）のadapterで、無ければOIDCのログインuse caseを作らない。
   */
  humanAuth: { initialOwnerEmail: string | null; identityProvider?: HumanIdentityProvider | null } = {
    initialOwnerEmail: null,
  },
) => {
  // Directionのrepositoryへは同じ接続を、Directionが所有するtableの型で渡す。
  const directionDatabase = asDirectionDatabase(applicationDatabase);
  const projectRepository = new SQLiteProjectRepository(directionDatabase, projectOwnerMembershipWriter);
  const intentRepository = new SQLiteIntentRepository(directionDatabase);
  const outcomeRepository = new SQLiteOutcomeRepository(directionDatabase);
  const researchRepository = new SQLiteResearchRepository(directionDatabase, clock);
  const directionDecisionRepository = new SQLiteDirectionDecisionRepository(directionDatabase, clock);
  const adrHandoffRepository = new SQLiteAdrHandoffRepository(directionDatabase);
  const runtimeEventRepository = new SQLiteRuntimeEventRepository(directionDatabase);
  // Accessのrepositoryへは同じ接続をAccessのtableの型で渡し、Project状態（Direction）は同じtransactionで読む実装を渡す。
  const accessDatabase = asAccessDatabase(applicationDatabase);
  const accessProjects = accessProjectReaders(accessDatabase);
  const projectGrantRepository = new SQLiteProjectGrantRepository(accessDatabase, accessProjectReaders, clock);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  const accessCredentialRepository = new SQLiteAccessCredentialRepository(accessDatabase, accessProjectReaders);
  const getProjectUseCase = new GetProjectUseCase(projectRepository);
  // Activity（意味のある履歴）。Change Log・Operational Logとは別のtableで、Projectの状態はDirectionのreaderで読む。
  const activityStore = new KyselyActivityStore(asActivityDatabase(applicationDatabase));
  const activityProjects = activityProjectReader(applicationDatabase);
  const listActivitiesUseCase = new ListActivitiesUseCase(activityProjects, activityStore);
  const getActivityUseCase = new GetActivityUseCase(activityProjects, activityStore);
  // Execution（旧Wachaから移植）。同じDB・同じプロセスの中で動き、Directionの参照は読取専用ポートだけを通す。
  // 重要な状態変更は、同じtransactionでcanonical Activityへ投影する。
  const workStore = new KyselyWorkStore(asWorkDatabase(applicationDatabase), workExternalReaders, workChangeActivityObserver);
  const taskCoordinationService = new TaskCoordinationService(
    workStore,
    new DirectionReferenceLookupService(projectRepository, outcomeRepository),
    clock,
  );
  // Direction → Executionは読取専用ポート（Execution自身のtableだけを読む）を通す。Direction側の還流先は自身のRepository。
  const executionSummaryService = new ExecutionSummaryService(workStore);
  const outcomeExecutionRepository = new SQLiteOutcomeExecutionRepository(directionDatabase);
  const outcomeEvaluationRepository = new SQLiteOutcomeEvaluationRepository(directionDatabase);
  // Human認証・Membership（docs/step-6-human-auth-design.md）。Agent GrantのRepository・認可とは分離する。
  const humanAccountRepository = new SQLiteHumanAccountRepository(accessDatabase, accessProjectReaders, clock);
  const projectMembershipRepository = new SQLiteProjectMembershipRepository(accessDatabase, accessProjectReaders, clock);
  const humanProjectAuthorizationService = new HumanProjectAuthorizationService(projectMembershipRepository);
  const loginAttemptRepository = new SQLiteLoginAttemptRepository(accessDatabase);
  const registerOrLoginHumanUseCase = new RegisterOrLoginHumanUseCase(humanAccountRepository, humanAuth.initialOwnerEmail);
  const identityProvider = humanAuth.identityProvider ?? null;
  /**
   * Agent Role Grant・Runtime Credentialで認可するservice。`X-Compass-Active-Role`の指定時は、認可をそのRoleのGrantだけに
   * 固定した組をrequestごとに作る（`forActiveRole`）。Human向けWeb APIはMembershipで認可するため含めない。
   */
  const roleAuthorizedServices = (
    projectAuthorization: ProjectAuthorizationService,
    coordination: TaskCoordinationService,
  ) => {
    // Runtime向けの入口はRuntime Credentialのscopeで認可する（trusted-localのAgent名だけ暫定のruntime Grant）。
    const runtimeAuthorization = new RuntimeAuthorizationService(projectAuthorization);
    const activityAuthorizationPort = activityAuthorization(projectAuthorization);
    return {
      projectAuthorizationService: projectAuthorization,
      runtimeAuthorizationService: runtimeAuthorization,
      taskCoordinationService: coordination,
      fetchRuntimeEventsUseCase: new FetchRuntimeEventsUseCase(
        runtimeAuthorization,
        projectRepository,
        runtimeEventRepository,
      ),
      ackRuntimeEventUseCase: new AckRuntimeEventUseCase(
        runtimeAuthorization,
        projectRepository,
        runtimeEventRepository,
        clock,
      ),
      recordExecutionEvidenceUseCase: new RecordExecutionEvidenceUseCase(
        runtimeAuthorization,
        projectRepository,
        outcomeRepository,
        executionSummaryService,
        outcomeExecutionRepository,
        clock,
      ),
      getEvaluatorContextUseCase: new GetEvaluatorContextUseCase(
        projectAuthorization,
        projectRepository,
        intentRepository,
        outcomeRepository,
        outcomeExecutionRepository,
        outcomeEvaluationRepository,
      ),
      recordOutcomeEvaluationUseCase: new RecordOutcomeEvaluationUseCase(
        projectAuthorization,
        projectRepository,
        outcomeRepository,
        outcomeExecutionRepository,
        outcomeEvaluationRepository,
        clock,
      ),
      getResearcherContextUseCase: new GetResearcherContextUseCase(
        projectAuthorization,
        projectRepository,
        intentRepository,
        researchRepository,
      ),
      getRoleContextUseCase: new GetRoleContextUseCase(
        projectAuthorization,
        agentContextService,
        getProjectUseCase,
        listActivitiesUseCase,
      ),
      recordActivityUseCase: new RecordActivityUseCase(activityAuthorizationPort, activityProjects, activityStore, clock),
      agentActivityReader: new AgentActivityReader(activityAuthorizationPort, listActivitiesUseCase, getActivityUseCase),
      getStrategistContextUseCase: new GetStrategistContextUseCase(
        projectAuthorization,
        projectRepository,
        intentRepository,
        outcomeRepository,
        researchRepository,
        directionDecisionRepository,
        outcomeEvaluationRepository,
      ),
    };
  };
  const services = {
    agentContextService,
    ...roleAuthorizedServices(projectAuthorizationService, taskCoordinationService),
    createProjectUseCase: new CreateProjectUseCase(projectRepository),
    updateProjectUseCase: new UpdateProjectUseCase(projectRepository),
    archiveProjectUseCase: new ArchiveProjectUseCase(projectRepository),
    listProjectsUseCase: new ListProjectsUseCase(projectRepository),
    getProjectUseCase,
    createIntentUseCase: new CreateIntentUseCase(projectRepository, intentRepository),
    listIntentsUseCase: new ListIntentsUseCase(projectRepository, intentRepository),
    getIntentUseCase: new GetIntentUseCase(projectRepository, intentRepository),
    updateIntentUseCase: new UpdateIntentUseCase(projectRepository, intentRepository),
    abandonIntentUseCase: new AbandonIntentUseCase(projectRepository, intentRepository),
    createOutcomeUseCase: new CreateOutcomeUseCase(projectRepository, outcomeRepository),
    listOutcomesUseCase: new ListOutcomesUseCase(projectRepository, intentRepository, outcomeRepository),
    getOutcomeUseCase: new GetOutcomeUseCase(projectRepository, intentRepository, outcomeRepository),
    updateOutcomeUseCase: new UpdateOutcomeUseCase(projectRepository, outcomeRepository),
    cancelOutcomeUseCase: new CancelOutcomeUseCase(projectRepository, outcomeRepository),
    createResearchRequestUseCase: new CreateResearchRequestUseCase(projectRepository, researchRepository),
    listResearchRequestsUseCase: new ListResearchRequestsUseCase(projectRepository, researchRepository),
    getResearchRequestUseCase: new GetResearchRequestUseCase(projectRepository, researchRepository),
    registerResearchResultUseCase: new RegisterResearchResultUseCase(projectRepository, researchRepository),
    registerResearchSynthesisUseCase: new RegisterResearchSynthesisUseCase(projectRepository, researchRepository),
    completeResearchRequestUseCase: new CompleteResearchRequestUseCase(projectRepository, researchRepository),
    cancelResearchRequestUseCase: new CancelResearchRequestUseCase(projectRepository, researchRepository),
    listRuntimeEventsUseCase: new ListRuntimeEventsUseCase(projectRepository, runtimeEventRepository),
    getExecutionSummaryUseCase: new GetExecutionSummaryUseCase(
      projectRepository,
      outcomeRepository,
      outcomeExecutionRepository,
    ),
    listOutcomeEvaluationsUseCase: new ListOutcomeEvaluationsUseCase(
      projectRepository,
      outcomeRepository,
      outcomeEvaluationRepository,
    ),
    listExecutionUseCase: new ListExecutionUseCase(taskCoordinationService),
    getExecutionTaskUseCase: new GetExecutionTaskUseCase(taskCoordinationService),
    listRecentExecutionChangesUseCase: new ListRecentExecutionChangesUseCase(taskCoordinationService),
    grantProjectRoleUseCase: new GrantProjectRoleUseCase(accessProjects, projectGrantRepository),
    revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(accessProjects, projectGrantRepository),
    listProjectGrantsUseCase: new ListProjectGrantsUseCase(accessProjects, projectGrantRepository),
    humanProjectAuthorizationService,
    authenticateAccessCredentialUseCase: new AuthenticateAccessCredentialUseCase(accessCredentialRepository, clock),
    issueAccessCredentialUseCase: new IssueAccessCredentialUseCase(
      humanProjectAuthorizationService,
      accessCredentialRepository,
      clock,
    ),
    rotateAccessCredentialUseCase: new RotateAccessCredentialUseCase(
      humanProjectAuthorizationService,
      accessCredentialRepository,
      clock,
    ),
    revokeAccessCredentialUseCase: new RevokeAccessCredentialUseCase(
      humanProjectAuthorizationService,
      accessCredentialRepository,
      clock,
    ),
    listAccessCredentialsUseCase: new ListAccessCredentialsUseCase(humanProjectAuthorizationService, accessCredentialRepository),
    registerOrLoginHumanUseCase,
    getHumanAuthBootstrapStatusUseCase: new GetHumanAuthBootstrapStatusUseCase(humanAccountRepository),
    startOidcLoginUseCase: identityProvider
      ? new StartOidcLoginUseCase(loginAttemptRepository, identityProvider, clock)
      : null,
    completeOidcLoginUseCase: identityProvider
      ? new CompleteOidcLoginUseCase(loginAttemptRepository, identityProvider, registerOrLoginHumanUseCase, clock)
      : null,
    localDevLoginUseCase: new LocalDevLoginUseCase(registerOrLoginHumanUseCase),
    resolveHumanSessionUseCase: new ResolveHumanSessionUseCase(humanAccountRepository),
    revokeHumanSessionUseCase: new RevokeHumanSessionUseCase(humanAccountRepository),
    listProjectMembersUseCase: new ListProjectMembersUseCase(humanProjectAuthorizationService, projectMembershipRepository),
    changeProjectMemberRoleUseCase: new ChangeProjectMemberRoleUseCase(
      humanProjectAuthorizationService,
      projectMembershipRepository,
    ),
    revokeProjectMemberUseCase: new RevokeProjectMemberUseCase(humanProjectAuthorizationService, projectMembershipRepository),
    createProjectInvitationUseCase: new CreateProjectInvitationUseCase(
      humanProjectAuthorizationService,
      projectMembershipRepository,
      clock,
    ),
    listProjectInvitationsUseCase: new ListProjectInvitationsUseCase(
      humanProjectAuthorizationService,
      projectMembershipRepository,
    ),
    revokeProjectInvitationUseCase: new RevokeProjectInvitationUseCase(
      humanProjectAuthorizationService,
      projectMembershipRepository,
    ),
    createDirectionDecisionUseCase: new CreateDirectionDecisionUseCase(
      projectRepository,
      researchRepository,
      directionDecisionRepository,
    ),
    decideNextOutcomeUseCase: new DecideNextOutcomeUseCase(
      projectRepository,
      researchRepository,
      directionDecisionRepository,
    ),
    createAdrHandoffRequestUseCase: new CreateAdrHandoffRequestUseCase(projectRepository, adrHandoffRepository),
    recordAdrReferenceUseCase: new RecordAdrReferenceUseCase(projectRepository, adrHandoffRepository),
    listAdrReferencesUseCase: new ListAdrReferencesUseCase(projectRepository, adrHandoffRepository),
    listDirectionDecisionsUseCase: new ListDirectionDecisionsUseCase(
      projectRepository,
      intentRepository,
      directionDecisionRepository,
    ),
  };
  const authorized = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, ...args: Args): Promise<Result> },
  ) => new HumanAuthorizedUseCase(humanProjectAuthorizationService, operation, useCase);
  const operator = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, operatorPrincipalId: string, ...args: Args): Promise<Result> },
  ) => new HumanOperatorUseCase(humanProjectAuthorizationService, operation, useCase);
  // Human向けWeb APIの入口。Membershipの認可（domainの権限表）を通してから、MCPと共通のuse caseへ委譲する。
  // Runtime向け（runtime-events・execution-evidence）はHuman向けではないため含めない。
  const human = {
    listProjects: new ListHumanProjectsUseCase(services.listProjectsUseCase, projectMembershipRepository),
    getProject: new GetHumanProjectUseCase(humanProjectAuthorizationService, services.getProjectUseCase),
    updateProject: authorized("project.update", services.updateProjectUseCase),
    archiveProject: authorized("project.archive", services.archiveProjectUseCase),
    createIntent: authorized("direction.write", services.createIntentUseCase),
    listIntents: authorized("project.read", services.listIntentsUseCase),
    getIntent: authorized("project.read", services.getIntentUseCase),
    updateIntent: authorized("direction.write", services.updateIntentUseCase),
    abandonIntent: authorized("direction.write", services.abandonIntentUseCase),
    createOutcome: authorized("direction.write", services.createOutcomeUseCase),
    listOutcomes: authorized("project.read", services.listOutcomesUseCase),
    getOutcome: authorized("project.read", services.getOutcomeUseCase),
    updateOutcome: authorized("direction.write", services.updateOutcomeUseCase),
    cancelOutcome: authorized("direction.write", services.cancelOutcomeUseCase),
    grantProjectRole: authorized("grant.manage", services.grantProjectRoleUseCase),
    revokeProjectRole: authorized("grant.manage", services.revokeProjectRoleUseCase),
    listProjectGrants: authorized("grant.read", services.listProjectGrantsUseCase),
    listResearchRequests: authorized("project.read", services.listResearchRequestsUseCase),
    getResearchRequest: authorized("project.read", services.getResearchRequestUseCase),
    listDirectionDecisions: authorized("project.read", services.listDirectionDecisionsUseCase),
    listAdrReferences: authorized("project.read", services.listAdrReferencesUseCase),
    getExecutionSummary: authorized("project.read", services.getExecutionSummaryUseCase),
    listOutcomeEvaluations: authorized("project.read", services.listOutcomeEvaluationsUseCase),
    // Execution閲覧（Task 45）。archivedのProjectも参照できる（介入はTask 46の`execution.intervene`）。
    listExecution: authorized("project.read", services.listExecutionUseCase),
    getExecutionTask: authorized("project.read", services.getExecutionTaskUseCase),
    listRecentExecutionChanges: authorized("project.read", services.listRecentExecutionChangesUseCase),
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
  };
  /** 操作Contextを1つのactiveRoleに固定したservice（MCP・Runtime向けAPIのrequestごと）。Human向けの入口は変えない。 */
  const forActiveRole = (activeRole: ProjectRole) => ({
    ...services,
    human,
    ...roleAuthorizedServices(
      projectAuthorizationService.forActiveRole(activeRole),
      taskCoordinationService.forActiveRole(activeRole),
    ),
  });
  return { ...services, human, forActiveRole };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;
/** 1 requestの操作Contextで使うservice。activeRoleの指定時は`forActiveRole`の結果、未指定時はApplicationServicesそのもの。 */
export type OperationServices = Omit<ApplicationServices, "forActiveRole">;
