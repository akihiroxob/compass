import type { ConsultationUnitOfWork } from "@compass/collaboration";
import type { AccessInfrastructure } from "./accessInfrastructure.ts";
import { createDirectionServices } from "./directionServices.ts";
import { createDirectionFoundation, type DirectionRepositoryOverrides } from "./directionFoundation.ts";
import { createAccessServices } from "./accessServices.ts";
import { createActivityServices, type ActivityInfrastructure } from "./activityServices.ts";
import { createConsultationServices } from "./consultationServices.ts";
import { createWorkServices } from "./workServices.ts";
import type { ApplicationServices, OperationServices } from "../application/ApplicationServices.ts";
import { createRoleAuthorizedServices } from "../application/createRoleAuthorizedServices.ts";
import { createHumanServices } from "../application/createHumanServices.ts";

import { createSqliteOrganizationInfrastructure, type OrganizationInfrastructure } from "./organizationInfrastructure.ts";
import { createProjectExecutionSummaryReader, createWorkspaceProjectIdsReader } from "../application/executionReadAdapters.ts";
import { AgentContextService } from "../application/agentContext/AgentContextService.ts";

import { activityActorContext } from "../infrastructure/activity/NodeActivityActorContext.ts";
import { FileAgentAssetRepository } from "../infrastructure/agentAssets/FileAgentAssetRepository.ts";
import { DirectionReferenceLookupService } from "@compass/direction";
import {
  ArchiveProjectUseCase,
  CreateProjectUseCase,
  GetProjectUseCase,
  GetWorkspaceUseCase,
  ListProjectsUseCase,
  ListWorkspaceProjectsUseCase,
  UpdateProjectUseCase,
} from "@compass/organization";
import {
  GetExecutionTaskUseCase,
  ListExecutionUseCase,
  SearchExecutionWorkUseCase,
  ListRecentExecutionChangesUseCase,
  TaskCoordinationService,
  type PullRequestGateway,
  type RevisionGateway,
  type WorkStore,
} from "@compass/work";
import {
  AuthenticateAccessCredentialUseCase,
  CompleteOidcLoginUseCase,
  CreateWorkspaceInvitationUseCase,
  GetHumanAuthBootstrapStatusUseCase,
  GrantWorkspaceRoleUseCase,
  RevokeWorkspaceRoleUseCase,
  ListWorkspaceGrantsUseCase,
  ListWorkspaceAgentRunsUseCase,
  RecordAgentRunUseCase,
  RoleScopeAuthorizationService,
  GrantProjectRoleUseCase,
  IssueAccessCredentialUseCase,
  ListAccessCredentialsUseCase,
  ListProjectGrantsUseCase,
  ListWorkspaceInvitationsUseCase,
  LocalDevLoginUseCase,
  ProjectAuthorizationService,
  ResolveHumanSessionUseCase,
  RevokeAccessCredentialUseCase,
  RevokeHumanSessionUseCase,
  RevokeWorkspaceInvitationUseCase,
  RevokeProjectRoleUseCase,
  RotateAccessCredentialUseCase,
  StartOidcLoginUseCase,
  type HumanIdentityProvider,
  type ProjectRole,
} from "@compass/access";

import type { Kysely } from "kysely";

import type { Database } from "../infrastructure/database/schema.ts";

/** DBを開かずにUse Caseを組み立てる。 */
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
  /**
   * 外部連携のadapter。`pullRequests`はGitHubのPR読取で、無ければPR登録をGITHUB_UNAVAILABLEで拒否する。
   * `revisions`はGitHubのcommitの関係の読取で、無ければGitHub Repositoryの公開記録をGITHUB_UNAVAILABLEで拒否する。
   */
  integrations: { pullRequests?: PullRequestGateway | null; revisions?: RevisionGateway | null } = {},
  /** Organizationの永続化契約。未指定時は同じDBを使うSQLite実装。 */
  organization: OrganizationInfrastructure = createSqliteOrganizationInfrastructure(applicationDatabase),
  infrastructure: { access?: AccessInfrastructure; direction?: DirectionRepositoryOverrides; work?: WorkStore; activity?: ActivityInfrastructure; consultation?: (references: DirectionReferenceLookupService) => ConsultationUnitOfWork } = {},
): ApplicationServices => {
  // Project（Workspaceを含む）はOrganizationが所有する。Projectのarchiveも同じtransactionでcanonical Activityへ投影する。
  const {
    projectRepository,
    workspaceRepository,
  } = organization;
  const directionFoundation = createDirectionFoundation(applicationDatabase, workspaceRepository, clock, infrastructure.direction);
  const {
    workspaceIntentRepository,
    workspaceOutcomeRepository,
    outcomeTargetProjectRepository,
    workspaceResearchRepository,
    workspaceDecisionRepository,
    outcomeExecutionRepository,
    outcomeEvaluationRepository,
  } = directionFoundation;
  const {
    accessProjects,
    projectGrantRepository,
    projectAuthorizationService,
    workspaceGrantRepository,
    roleScopeAuthorizationService,
    agentRunRepository,
    accessCredentialRepository,
    humanAccountRepository,
    workspaceMembershipRepository,
    humanProjectAuthorizationService,
    workspaceInvitationRepository,
    humanWorkspaceAuthorizationService,
    credentialScopeAuthorization,
    loginAttemptRepository,
    registerOrLoginHumanUseCase,
    identityProvider,
  } = createAccessServices(applicationDatabase, clock, humanAuth, infrastructure.access);
  const getProjectUseCase = new GetProjectUseCase(projectRepository);
  const {
    listActivitiesUseCase,
    getActivityUseCase,
    listWorkspaceActivitiesUseCase,
    getWorkspaceActivityUseCase,
    listWorkspaceActivityStreamUseCase,
    activityUnitOfWork,
  } = createActivityServices(applicationDatabase, infrastructure.activity);
  // 相談（Collaboration）。照合・追記・受付記録と、scopeの状態・参照先Task/Story/Intent/Outcomeの読取りを同じtransactionで行う。
  // Web API（Human）とMCP（Agent）は同じuse caseへ委譲し、記録主体と判断の由来は入口が決める。
  // 文書反映Taskの起票はWorkの通常の起票処理を同じtransactionで使う。Story作成以外ではDirectionの参照を読まない。
  const directionReferenceLookup = new DirectionReferenceLookupService(projectRepository, workspaceOutcomeRepository, outcomeTargetProjectRepository);
  const {
    consultations,
  } = createConsultationServices(applicationDatabase, directionReferenceLookup, clock, infrastructure.consultation?.(directionReferenceLookup));
  const work = createWorkServices(applicationDatabase, directionReferenceLookup, accessCredentialRepository, clock, integrations, infrastructure.work);
  const {
    taskCoordinationService,
    recordPublicationUseCase,
    listProjectReleasesUseCase,
    executionSummaryService,
  } = work;
  const {
    workspaceContexts,
    workspaceDirection,
  } = createDirectionServices(applicationDatabase, organization, directionFoundation, work, clock);
  const roleServicesDependencies = {
    getProjectUseCase,
    consultations,
    workspaceRepository,
    projectRepository,
    recordPublicationUseCase,
    agentContextService,
    listActivitiesUseCase,
    getActivityUseCase,
    listWorkspaceActivitiesUseCase,
    getWorkspaceActivityUseCase,
    activityUnitOfWork,
    clock,
    workspaceContexts,
    workspaceIntentRepository,
    workspaceOutcomeRepository,
    workspaceResearchRepository,
    workspaceDecisionRepository,
    outcomeEvaluationRepository,
    outcomeTargetProjectRepository,
    outcomeExecutionRepository,
    executionSummaryService,
    workspaceDirection,
  };
  const roleAuthorizedServices = (projectAuthorization: ProjectAuthorizationService, roleScopeAuthorization: RoleScopeAuthorizationService, coordination: TaskCoordinationService) =>
    createRoleAuthorizedServices(roleServicesDependencies, projectAuthorization, roleScopeAuthorization, coordination);
  const services = {
    agentContextService,
    ...roleAuthorizedServices(projectAuthorizationService, roleScopeAuthorizationService, taskCoordinationService),
    createProjectUseCase: new CreateProjectUseCase(projectRepository),
    updateProjectUseCase: new UpdateProjectUseCase(projectRepository),
    archiveProjectUseCase: new ArchiveProjectUseCase(projectRepository),
    listProjectsUseCase: new ListProjectsUseCase(projectRepository),
    getProjectUseCase,
    // Direction（Workspace所有）。第1引数はWorkspace ID。Project IDをWorkspace IDとして受け付けない。
    createIntentUseCase: workspaceDirection.createIntentUseCase,
    listIntentsUseCase: workspaceDirection.listIntentsUseCase,
    getIntentUseCase: workspaceDirection.getIntentUseCase,
    updateIntentUseCase: workspaceDirection.updateIntentUseCase,
    listIntentRevisionsUseCase: workspaceDirection.listIntentRevisionsUseCase,
    abandonIntentUseCase: workspaceDirection.abandonIntentUseCase,
    createOutcomeUseCase: workspaceDirection.createOutcomeUseCase,
    listOutcomesUseCase: workspaceDirection.listOutcomesUseCase,
    getOutcomeUseCase: workspaceDirection.getOutcomeUseCase,
    updateOutcomeUseCase: workspaceDirection.updateOutcomeUseCase,
    cancelOutcomeUseCase: workspaceDirection.cancelOutcomeUseCase,
    // Target Projectの設定・解除はStrategistの判断（MCP）。一覧はWorkspace member・Workspace Role Grantで読む。
    setOutcomeTargetProjectUseCase: workspaceDirection.setOutcomeTargetProjectUseCase,
    unsetOutcomeTargetProjectUseCase: workspaceDirection.unsetOutcomeTargetProjectUseCase,
    listOutcomeTargetProjectsUseCase: workspaceDirection.listOutcomeTargetProjectsUseCase,
    listOutcomeTargetWorkUseCase: workspaceDirection.listOutcomeTargetWorkUseCase,
    listWorkspaceOutcomesUseCase: workspaceDirection.listWorkspaceOutcomesUseCase,
    getWorkspaceOutcomeOverviewUseCase: workspaceDirection.getWorkspaceOutcomeOverviewUseCase,
    listOutcomeTargetExecutionsUseCase: workspaceDirection.listOutcomeTargetExecutionsUseCase,
    createResearchRequestUseCase: workspaceDirection.createResearchRequestUseCase,
    listResearchRequestsUseCase: workspaceDirection.listResearchRequestsUseCase,
    getResearchRequestUseCase: workspaceDirection.getResearchRequestUseCase,
    registerResearchResultUseCase: workspaceDirection.registerResearchResultUseCase,
    registerResearchSynthesisUseCase: workspaceDirection.registerResearchSynthesisUseCase,
    completeResearchRequestUseCase: workspaceDirection.completeResearchRequestUseCase,
    cancelResearchRequestUseCase: workspaceDirection.cancelResearchRequestUseCase,
    listOutcomeEvaluationsUseCase: workspaceDirection.listOutcomeEvaluationsUseCase,
    createDirectionDecisionUseCase: workspaceDirection.createDirectionDecisionUseCase,
    decideNextOutcomeUseCase: workspaceDirection.decideNextOutcomeUseCase,
    listDirectionDecisionsUseCase: workspaceDirection.listDirectionDecisionsUseCase,
    listIntentMetricsUseCase: workspaceDirection.listIntentMetricsUseCase,
    listIntentExplanationsUseCase: workspaceDirection.listIntentExplanationsUseCase,
    // ADR依頼・参照はWorkspace所有で、対象artifactのProject（`projectId`）は入力で明示する。
    createAdrHandoffRequestUseCase: workspaceDirection.createAdrHandoffRequestUseCase,
    recordAdrReferenceUseCase: workspaceDirection.recordAdrReferenceUseCase,
    listAdrReferencesUseCase: workspaceDirection.listAdrReferencesUseCase,
    // Execution SummaryはProject固有の記録。Projectの所属Workspaceを明示して読む。
    getExecutionSummaryUseCase: createProjectExecutionSummaryReader(projectRepository, workspaceDirection.getExecutionSummaryUseCase),
    listExecutionUseCase: new ListExecutionUseCase(taskCoordinationService),
    searchExecutionWorkUseCase: new SearchExecutionWorkUseCase(taskCoordinationService),
    getExecutionTaskUseCase: new GetExecutionTaskUseCase(taskCoordinationService),
    listRecentExecutionChangesUseCase: new ListRecentExecutionChangesUseCase(taskCoordinationService),
    grantWorkspaceRoleUseCase: new GrantWorkspaceRoleUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    revokeWorkspaceRoleUseCase: new RevokeWorkspaceRoleUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    listWorkspaceGrantsUseCase: new ListWorkspaceGrantsUseCase(new GetWorkspaceUseCase(workspaceRepository), workspaceGrantRepository),
    // Agentの実行観測（Ralph・Orchestratorの報告）。Activityには書かず、Grant・Credential・Claimから導かない。
    recordAgentRunUseCase: new RecordAgentRunUseCase(agentRunRepository, workspaceGrantRepository, projectGrantRepository, clock),
    listWorkspaceAgentRunsUseCase: new ListWorkspaceAgentRunsUseCase(
      createWorkspaceProjectIdsReader(new ListWorkspaceProjectsUseCase(workspaceRepository, projectRepository)),
      agentRunRepository,
      clock,
    ),
    grantProjectRoleUseCase: new GrantProjectRoleUseCase(accessProjects, projectGrantRepository),
    revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(accessProjects, projectGrantRepository),
    listProjectGrantsUseCase: new ListProjectGrantsUseCase(accessProjects, projectGrantRepository),
    humanProjectAuthorizationService,
    humanWorkspaceAuthorizationService,
    authenticateAccessCredentialUseCase: new AuthenticateAccessCredentialUseCase(accessCredentialRepository, clock),
    issueAccessCredentialUseCase: new IssueAccessCredentialUseCase(credentialScopeAuthorization, accessCredentialRepository, clock),
    rotateAccessCredentialUseCase: new RotateAccessCredentialUseCase(credentialScopeAuthorization, accessCredentialRepository, clock),
    revokeAccessCredentialUseCase: new RevokeAccessCredentialUseCase(credentialScopeAuthorization, accessCredentialRepository, clock),
    listAccessCredentialsUseCase: new ListAccessCredentialsUseCase(credentialScopeAuthorization, accessCredentialRepository),
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
    createWorkspaceInvitationUseCase: new CreateWorkspaceInvitationUseCase(
      humanWorkspaceAuthorizationService,
      workspaceInvitationRepository,
      clock,
    ),
    listWorkspaceInvitationsUseCase: new ListWorkspaceInvitationsUseCase(
      humanWorkspaceAuthorizationService,
      workspaceInvitationRepository,
    ),
    revokeWorkspaceInvitationUseCase: new RevokeWorkspaceInvitationUseCase(
      humanWorkspaceAuthorizationService,
      workspaceInvitationRepository,
    ),
  };
  const human = createHumanServices({
    services,
    humanProjectAuthorizationService,
    humanWorkspaceAuthorizationService,
    activityActorContext,
    agentContextService,
    taskCoordinationService,
    projectRepository,
    workspaceRepository,
    workspaceMembershipRepository,
    listActivitiesUseCase,
    getActivityUseCase,
    listWorkspaceActivitiesUseCase,
    getWorkspaceActivityUseCase,
    listWorkspaceActivityStreamUseCase,
    listProjectReleasesUseCase,
    consultations,
  });
  /** 操作Contextを1つのactiveRoleに固定したservice（MCP・Runtime向けAPIのrequestごと）。Human向けの入口は変えない。 */
  const forActiveRole = (activeRole: ProjectRole): OperationServices => ({
    ...services,
    activityActorContext,
    human,
    ...roleAuthorizedServices(
      projectAuthorizationService.forActiveRole(activeRole),
      roleScopeAuthorizationService.forActiveRole(activeRole),
      taskCoordinationService.forActiveRole(activeRole),
    ),
  });
  return { ...services, activityActorContext, workspaceDirection: { ...workspaceDirection, ...workspaceContexts }, human, forActiveRole };
};

export type { ApplicationServices, OperationServices } from "../application/ApplicationServices.ts";
