import { resolveProjectDirectionWorkspace, projectDirectionContext, projectDecisionReader, projectResearchReader, projectDirectionRepositories, projectDirectionUseCase } from "../infrastructure/repository/projectDirectionAdapter.ts";
import { AgentContextService } from "../application/agentContext/AgentContextService.ts";
import { GetRoleContextUseCase } from "../application/agentContext/GetRoleContextUseCase.ts";
import { withActivityActor } from "../application/activityActor.ts";
import { FileAgentAssetRepository } from "../infrastructure/agentAssets/FileAgentAssetRepository.ts";
import {
  AbandonIntentUseCase,
  AckRuntimeEventUseCase,
  CancelOutcomeUseCase,
  CancelResearchRequestUseCase,
  CompleteResearchRequestUseCase,
  CreateAdrHandoffRequestUseCase,
  CreateDirectionDecisionUseCase,
  CreateIntentUseCase,
  CreateOutcomeUseCase,
  CreateResearchRequestUseCase,
  DecideNextOutcomeUseCase,
  DirectionReferenceLookupService,
  FetchRuntimeEventsUseCase,
  GetEvaluatorContextUseCase,
  GetExecutionSummaryUseCase,
  GetOrchestrationStateUseCase,
  GetIntentUseCase,
  GetOutcomeUseCase,
  GetResearcherContextUseCase,
  GetResearchRequestUseCase,
  GetStrategistContextUseCase,
  ListAdrReferencesUseCase,
  ListDirectionDecisionsUseCase,
  ListIntentsUseCase,
  ListOutcomeEvaluationsUseCase,
  ListOutcomesUseCase,
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
  SQLiteResearchRepository,
  SQLiteRuntimeEventRepository,
  UpdateIntentUseCase,
  UpdateOutcomeUseCase,
} from "@compass/direction";
import {
  ArchiveProjectUseCase,
  ArchiveWorkspaceUseCase,
  CreateProjectUseCase,
  CreateWorkspaceProjectUseCase,
  CreateWorkspaceUseCase,
  GetProjectUseCase,
  GetWorkspaceUseCase,
  ListProjectsUseCase,
  ListWorkspacesUseCase,
  ListWorkspaceProjectsUseCase,
  SQLiteProjectRepository,
  SQLiteWorkspaceRepository,
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
  GrantWorkspaceRoleUseCase,
  RevokeWorkspaceRoleUseCase,
  ListWorkspaceGrantsUseCase,
  SQLiteWorkspaceGrantRepository,
  RoleScopeAuthorizationService,
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
  SQLiteWorkspaceMembershipRepository,
  StartOidcLoginUseCase,
  AddWorkspaceMemberUseCase,
  ChangeWorkspaceMemberRoleUseCase,
  CreateHumanWorkspaceProjectUseCase,
  GetHumanWorkspaceUseCase,
  HumanWorkspaceAuthorizationService,
  HumanWorkspaceAuthorizedUseCase,
  ListHumanWorkspacesUseCase,
  ListWorkspaceMembersUseCase,
  RevokeWorkspaceMemberUseCase,
  humanOperatorPrincipalId,
  type HumanActor,
  type HumanIdentityProvider,
  type HumanProjectOperation,
  type HumanWorkspaceOperation,
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
import {
  asAccessDatabase,
  asActivityDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "./database/contextDatabase.ts";
import type { Database } from "./database/schema.ts";
import {
  accessProjectReaders,
  accessWorkspaceReaders,
  activityAuthorization,
  activityProjectReader,
  directionChangeObserver,
  directionProjectReaders,
  directionWorkspaceReaders,
  ownerMembershipWriters,
  projectChangeActivityObserver,
  projectRepositoryReferenceFinder,
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
  // Project（Workspaceを含む）はOrganizationが所有する。Projectのarchiveも同じtransactionでcanonical Activityへ投影する。
  const projectRepository = new SQLiteProjectRepository(
    asOrganizationDatabase(applicationDatabase),
    projectRepositoryReferenceFinder,
    ownerMembershipWriters,
    projectChangeActivityObserver,
  );
  const workspaceRepository = new SQLiteWorkspaceRepository(
    asOrganizationDatabase(applicationDatabase),
    ownerMembershipWriters.workspace,
  );
  // Directionのrepositoryへは同じ接続を、自身のtable型で渡す。Workspace/Project状態は同じtransactionで読むreaderを渡す。
  const directionDatabase = asDirectionDatabase(applicationDatabase);
  // Directionの重要な状態変更も、同じtransactionでcanonical Activityへ投影する。
  const workspaceIntentRepository = new SQLiteIntentRepository(directionDatabase, directionWorkspaceReaders, directionChangeObserver);
  const workspaceOutcomeRepository = new SQLiteOutcomeRepository(directionDatabase, directionWorkspaceReaders, directionChangeObserver);
  const { intents: intentRepository, outcomes: outcomeRepository } = projectDirectionRepositories(projectRepository, workspaceIntentRepository, workspaceOutcomeRepository);
  const workspaceBasics = {
    createIntentUseCase: new CreateIntentUseCase(workspaceRepository, workspaceIntentRepository),
    listIntentsUseCase: new ListIntentsUseCase(workspaceRepository, workspaceIntentRepository),
    getIntentUseCase: new GetIntentUseCase(workspaceRepository, workspaceIntentRepository),
    updateIntentUseCase: new UpdateIntentUseCase(workspaceRepository, workspaceIntentRepository),
    abandonIntentUseCase: new AbandonIntentUseCase(workspaceRepository, workspaceIntentRepository),
    createOutcomeUseCase: new CreateOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
    listOutcomesUseCase: new ListOutcomesUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository),
    getOutcomeUseCase: new GetOutcomeUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository),
    updateOutcomeUseCase: new UpdateOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
    cancelOutcomeUseCase: new CancelOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
  };
  const workspaceResearchRepository = new SQLiteResearchRepository(
    directionDatabase,
    directionWorkspaceReaders,
    clock,
    directionChangeObserver,
  );
  const workspaceDecisionRepository = new SQLiteDirectionDecisionRepository(
    directionDatabase,
    directionWorkspaceReaders,
    clock,
    directionChangeObserver,
  );
  const researchRepository = projectResearchReader(projectRepository, workspaceResearchRepository);
  const directionDecisionRepository = projectDecisionReader(projectRepository, workspaceDecisionRepository);
  const adrHandoffRepository = new SQLiteAdrHandoffRepository(directionDatabase, directionProjectReaders, directionWorkspaceReaders);
  const workspaceDirectionBasics = {
    ...workspaceBasics,
    createAdrHandoffRequestUseCase: new CreateAdrHandoffRequestUseCase(workspaceRepository, adrHandoffRepository),
    recordAdrReferenceUseCase: new RecordAdrReferenceUseCase(workspaceRepository, adrHandoffRepository),
    listAdrReferencesUseCase: new ListAdrReferencesUseCase(workspaceRepository, adrHandoffRepository),
    createResearchRequestUseCase: new CreateResearchRequestUseCase(workspaceRepository, workspaceResearchRepository),
    listResearchRequestsUseCase: new ListResearchRequestsUseCase(workspaceRepository, workspaceResearchRepository),
    getResearchRequestUseCase: new GetResearchRequestUseCase(workspaceRepository, workspaceResearchRepository),
    registerResearchResultUseCase: new RegisterResearchResultUseCase(workspaceRepository, workspaceResearchRepository),
    registerResearchSynthesisUseCase: new RegisterResearchSynthesisUseCase(workspaceRepository, workspaceResearchRepository),
    completeResearchRequestUseCase: new CompleteResearchRequestUseCase(workspaceRepository, workspaceResearchRepository),
    cancelResearchRequestUseCase: new CancelResearchRequestUseCase(workspaceRepository, workspaceResearchRepository),
    createDirectionDecisionUseCase: new CreateDirectionDecisionUseCase(workspaceRepository, workspaceResearchRepository, workspaceDecisionRepository),
    decideNextOutcomeUseCase: new DecideNextOutcomeUseCase(workspaceRepository, workspaceResearchRepository, workspaceDecisionRepository),
    listDirectionDecisionsUseCase: new ListDirectionDecisionsUseCase(workspaceRepository, workspaceIntentRepository, workspaceDecisionRepository),
  };
  const runtimeEventRepository = new SQLiteRuntimeEventRepository(directionDatabase);
  // Accessのrepositoryへは同じ接続をAccessのtableの型で渡し、Project状態（Organization）は同じtransactionで読む実装を渡す。
  const accessDatabase = asAccessDatabase(applicationDatabase);
  const accessProjects = accessProjectReaders(accessDatabase);
  const projectGrantRepository = new SQLiteProjectGrantRepository(accessDatabase, accessProjectReaders, clock);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  const workspaceGrantRepository = new SQLiteWorkspaceGrantRepository(accessDatabase, accessWorkspaceReaders, clock);
  const roleScopeAuthorizationService = new RoleScopeAuthorizationService(workspaceGrantRepository, projectGrantRepository);
  const accessCredentialRepository = new SQLiteAccessCredentialRepository(accessDatabase, accessProjectReaders);
  const getProjectUseCase = new GetProjectUseCase(projectRepository);
  // Activity（意味のある履歴）。Change Log・Operational Logとは別のtableで、Projectの状態はOrganizationのreaderで読む。
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
  const outcomeExecutionRepository = new SQLiteOutcomeExecutionRepository(directionDatabase, directionProjectReaders, directionWorkspaceReaders);
  const outcomeEvaluationRepository = new SQLiteOutcomeEvaluationRepository(
    directionDatabase,
    directionWorkspaceReaders,
    directionChangeObserver,
  );
  const workspaceContexts = {
    getResearcherContextUseCase: new GetResearcherContextUseCase(workspaceRepository, workspaceIntentRepository, workspaceResearchRepository),
    getStrategistContextUseCase: new GetStrategistContextUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository,
      workspaceResearchRepository, workspaceDecisionRepository, outcomeEvaluationRepository),
    getEvaluatorContextUseCase: new GetEvaluatorContextUseCase(workspaceRepository, workspaceIntentRepository,
      workspaceOutcomeRepository, outcomeExecutionRepository, outcomeEvaluationRepository),
  };
  // Human認証・Membership（docs/step-6-human-auth-design.md）。Agent GrantのRepository・認可とは分離する。
  const workspaceDirection = {
    ...workspaceDirectionBasics,
    recordOutcomeEvaluationUseCase: new RecordOutcomeEvaluationUseCase(workspaceRepository, workspaceOutcomeRepository,
      outcomeExecutionRepository, outcomeEvaluationRepository, clock),
    listOutcomeEvaluationsUseCase: new ListOutcomeEvaluationsUseCase(workspaceRepository, workspaceOutcomeRepository, outcomeEvaluationRepository),
    recordExecutionEvidenceUseCase: new RecordExecutionEvidenceUseCase(projectRepository, workspaceOutcomeRepository,
      executionSummaryService, outcomeExecutionRepository, clock),
    getExecutionSummaryUseCase: new GetExecutionSummaryUseCase(projectRepository, workspaceOutcomeRepository, outcomeExecutionRepository),
    listRuntimeEventsUseCase: new ListRuntimeEventsUseCase(workspaceRepository, runtimeEventRepository),
    fetchRuntimeEventsUseCase: new FetchRuntimeEventsUseCase(workspaceRepository, runtimeEventRepository),
    ackRuntimeEventUseCase: new AckRuntimeEventUseCase(workspaceRepository, runtimeEventRepository, clock),
  };
  const humanAccountRepository = new SQLiteHumanAccountRepository(
    accessDatabase,
    accessProjectReaders,
    accessWorkspaceReaders,
    clock,
  );
  const projectMembershipRepository = new SQLiteProjectMembershipRepository(accessDatabase, accessProjectReaders, clock);
  const humanProjectAuthorizationService = new HumanProjectAuthorizationService(projectMembershipRepository);
  // Workspace Membership（handoff v2「14.1 Human」）。Project Membershipとは別に認可し、相互に継承しない。
  const workspaceMembershipRepository = new SQLiteWorkspaceMembershipRepository(
    accessDatabase,
    accessWorkspaceReaders,
    clock,
  );
  const humanWorkspaceAuthorizationService = new HumanWorkspaceAuthorizationService(workspaceMembershipRepository);
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
      fetchRuntimeEventsUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string, input: unknown = {}) => {
          const consumerId = await runtimeAuthorization.requireScope(caller, projectId, "runtime:event:read");
          return workspaceDirection.fetchRuntimeEventsUseCase.execute(consumerId, await resolveProjectDirectionWorkspace(projectRepository, projectId), input);
        },
      },
      ackRuntimeEventUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string, input: unknown) => {
          const consumerId = await runtimeAuthorization.requireScope(caller, projectId, "runtime:event:ack");
          return workspaceDirection.ackRuntimeEventUseCase.execute(consumerId, await resolveProjectDirectionWorkspace(projectRepository, projectId), input);
        },
      },
      recordExecutionEvidenceUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string, outcomeId: string, input: unknown) => {
          const principalId = await runtimeAuthorization.requireScope(caller, projectId, "execution:evidence:write");
          return projectDirectionUseCase(projectRepository, {
            execute: (workspaceId: string) => workspaceDirection.recordExecutionEvidenceUseCase.execute(principalId, workspaceId, projectId, outcomeId, input),
          }).execute(projectId);
        },
      },
      getOrchestrationStateUseCase: new GetOrchestrationStateUseCase(
        runtimeAuthorization,
        projectRepository,
        intentRepository,
        outcomeRepository,
        researchRepository,
        directionDecisionRepository,
        outcomeEvaluationRepository,
        outcomeExecutionRepository,
        executionSummaryService,
        clock,
      ),
      getEvaluatorContextUseCase: projectDirectionContext(projectRepository, projectAuthorization, "evaluator", workspaceContexts.getEvaluatorContextUseCase),
      recordOutcomeEvaluationUseCase: {
        execute: async (principal: string | null, projectId: string, outcomeId: string, input: unknown) => {
          const principalId = await projectAuthorization.requireRole(principal, projectId, "evaluator");
          return projectDirectionUseCase(projectRepository, workspaceDirection.recordOutcomeEvaluationUseCase).execute(projectId, principalId, outcomeId, input);
        },
      },
      getResearcherContextUseCase: projectDirectionContext(projectRepository, projectAuthorization, "researcher", workspaceContexts.getResearcherContextUseCase),
      getRoleContextUseCase: new GetRoleContextUseCase(
        projectAuthorization,
        agentContextService,
        getProjectUseCase,
        listActivitiesUseCase,
      ),
      recordActivityUseCase: new RecordActivityUseCase(activityAuthorizationPort, {
        execute: (work) => applicationDatabase.transaction().execute((transaction) =>
          work(new KyselyActivityStore(asActivityDatabase(transaction)), activityProjectReader(transaction)),
        ),
      }, clock),
      agentActivityReader: new AgentActivityReader(activityAuthorizationPort, listActivitiesUseCase, getActivityUseCase),
      getStrategistContextUseCase: projectDirectionContext(projectRepository, projectAuthorization, "strategist", workspaceContexts.getStrategistContextUseCase),
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
    createIntentUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.createIntentUseCase),
    listIntentsUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listIntentsUseCase),
    getIntentUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.getIntentUseCase),
    updateIntentUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.updateIntentUseCase),
    abandonIntentUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.abandonIntentUseCase),
    createOutcomeUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.createOutcomeUseCase),
    listOutcomesUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listOutcomesUseCase),
    getOutcomeUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.getOutcomeUseCase),
    updateOutcomeUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.updateOutcomeUseCase),
    cancelOutcomeUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.cancelOutcomeUseCase),
    createResearchRequestUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.createResearchRequestUseCase),
    listResearchRequestsUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listResearchRequestsUseCase),
    getResearchRequestUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.getResearchRequestUseCase),
    registerResearchResultUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.registerResearchResultUseCase),
    registerResearchSynthesisUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.registerResearchSynthesisUseCase),
    completeResearchRequestUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.completeResearchRequestUseCase),
    cancelResearchRequestUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.cancelResearchRequestUseCase),
    listRuntimeEventsUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listRuntimeEventsUseCase),
    getExecutionSummaryUseCase: {
      execute: (projectId: string, outcomeId: string) => projectDirectionUseCase(projectRepository, {
        execute: (workspaceId: string) => workspaceDirection.getExecutionSummaryUseCase.execute(workspaceId, projectId, outcomeId),
      }).execute(projectId),
    },
    listOutcomeEvaluationsUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listOutcomeEvaluationsUseCase),
    listExecutionUseCase: new ListExecutionUseCase(taskCoordinationService),
    getExecutionTaskUseCase: new GetExecutionTaskUseCase(taskCoordinationService),
    listRecentExecutionChangesUseCase: new ListRecentExecutionChangesUseCase(taskCoordinationService),
    roleScopeAuthorizationService,
    grantWorkspaceRoleUseCase: new GrantWorkspaceRoleUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    revokeWorkspaceRoleUseCase: new RevokeWorkspaceRoleUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    listWorkspaceGrantsUseCase: new ListWorkspaceGrantsUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    grantProjectRoleUseCase: new GrantProjectRoleUseCase(accessProjects, projectGrantRepository),
    revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(accessProjects, projectGrantRepository),
    listProjectGrantsUseCase: new ListProjectGrantsUseCase(accessProjects, projectGrantRepository),
    humanProjectAuthorizationService,
    humanWorkspaceAuthorizationService,
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
    createDirectionDecisionUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.createDirectionDecisionUseCase),
    decideNextOutcomeUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.decideNextOutcomeUseCase),
    createAdrHandoffRequestUseCase: { execute: async (projectId: string, principalId: string, input: unknown) =>
      projectDirectionUseCase(projectRepository, workspaceDirection.createAdrHandoffRequestUseCase).execute(projectId, principalId, { ...(input as object), projectId }) },
    recordAdrReferenceUseCase: { execute: async (projectId: string, principalId: string, input: unknown) =>
      projectDirectionUseCase(projectRepository, workspaceDirection.recordAdrReferenceUseCase).execute(projectId, principalId, { ...(input as object), projectId }) },
    listAdrReferencesUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listAdrReferencesUseCase),
    listDirectionDecisionsUseCase: projectDirectionUseCase(projectRepository, workspaceDirection.listDirectionDecisionsUseCase),
  };
  const authorized = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, ...args: Args): Promise<Result> },
  ) => new HumanAuthorizedUseCase(humanProjectAuthorizationService, operation, useCase);
  const operator = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, operatorPrincipalId: string, ...args: Args): Promise<Result> },
  ) => new HumanOperatorUseCase(humanProjectAuthorizationService, operation, useCase);
  // Project・Directionの変更。canonical Activityの操作者を認証済みHuman（`human:{humanUserId}`、立場operator）に固定する。
  const directionWrite = <Args extends unknown[], Result>(
    operation: HumanProjectOperation,
    useCase: { execute(projectId: string, ...args: Args): Promise<Result> },
  ) => {
    const inner = authorized(operation, useCase);
    return {
      execute: (actor: HumanActor, projectId: string, ...args: Args) =>
        withActivityActor({ principalId: humanOperatorPrincipalId(actor), role: "operator" }, () =>
          inner.execute(actor, projectId, ...args),
        ),
    };
  };
  const workspaceAuthorized = <Args extends unknown[], Result>(
    operation: HumanWorkspaceOperation,
    useCase: { execute(workspaceId: string, ...args: Args): Promise<Result> },
  ) => new HumanWorkspaceAuthorizedUseCase(humanWorkspaceAuthorizationService, operation, useCase);
  // Human向けWeb APIの入口。Membershipの認可（domainの権限表）を通してから、MCPと共通のuse caseへ委譲する。
  // Runtime向け（runtime-events・execution-evidence）はHuman向けではないため含めない。
  const human = {
    listProjects: new ListHumanProjectsUseCase(services.listProjectsUseCase, projectMembershipRepository),
    getProject: new GetHumanProjectUseCase(humanProjectAuthorizationService, services.getProjectUseCase),
    updateProject: directionWrite("project.update", services.updateProjectUseCase),
    archiveProject: directionWrite("project.archive", services.archiveProjectUseCase),
    createIntent: directionWrite("direction.write", services.createIntentUseCase),
    listIntents: authorized("project.read", services.listIntentsUseCase),
    getIntent: authorized("project.read", services.getIntentUseCase),
    updateIntent: directionWrite("direction.write", services.updateIntentUseCase),
    abandonIntent: directionWrite("direction.write", services.abandonIntentUseCase),
    createOutcome: directionWrite("direction.write", services.createOutcomeUseCase),
    listOutcomes: authorized("project.read", services.listOutcomesUseCase),
    getOutcome: authorized("project.read", services.getOutcomeUseCase),
    updateOutcome: directionWrite("direction.write", services.updateOutcomeUseCase),
    cancelOutcome: directionWrite("direction.write", services.cancelOutcomeUseCase),
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
    // Workspace（Workspace Membershipで認可）。参照（一覧・詳細・所属Project一覧）はWeb APIへ接続済み（S02-04）。
    // 作成・更新・archive・member管理の入口は未接続（S06-04・S09-03）。作成は認証済みであればよく、
    // 作成者を同一transactionでowner Membershipにする。
    createWorkspace: new CreateWorkspaceUseCase(workspaceRepository),
    listWorkspaces: new ListHumanWorkspacesUseCase(new ListWorkspacesUseCase(workspaceRepository), workspaceMembershipRepository),
    getWorkspace: new GetHumanWorkspaceUseCase(humanWorkspaceAuthorizationService, new GetWorkspaceUseCase(workspaceRepository)),
    // Workspace memberは所属Projectのpurpose・Resource参照を見られる。Project詳細・WorkはProject Membershipで認可し、継承しない。
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
    listWorkspaceMembers: new ListWorkspaceMembersUseCase(humanWorkspaceAuthorizationService, workspaceMembershipRepository),
    addWorkspaceMember: new AddWorkspaceMemberUseCase(humanWorkspaceAuthorizationService, workspaceMembershipRepository),
    changeWorkspaceMemberRole: new ChangeWorkspaceMemberRoleUseCase(
      humanWorkspaceAuthorizationService,
      workspaceMembershipRepository,
    ),
    revokeWorkspaceMember: new RevokeWorkspaceMemberUseCase(humanWorkspaceAuthorizationService, workspaceMembershipRepository),
  };
  /** 操作Contextを1つのactiveRoleに固定したservice（MCP・Runtime向けAPIのrequestごと）。Human向けの入口は変えない。 */
  const forActiveRole = (activeRole: ProjectRole) => ({
    ...services,
    roleScopeAuthorizationService: roleScopeAuthorizationService.forActiveRole(activeRole),
    human,
    ...roleAuthorizedServices(
      projectAuthorizationService.forActiveRole(activeRole),
      taskCoordinationService.forActiveRole(activeRole),
    ),
  });
  return { ...services, workspaceDirection: { ...workspaceDirection, ...workspaceContexts }, human, forActiveRole };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;
/** 1 requestの操作Contextで使うservice。activeRoleの指定時は`forActiveRole`の結果、未指定時はApplicationServicesそのもの。 */
export type OperationServices = Omit<ApplicationServices, "forActiveRole" | "workspaceDirection">;
