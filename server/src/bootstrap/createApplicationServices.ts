import { InstructionService } from "../mcp/InstructionService.ts";
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
import { HumanProjectAuthorizationService } from "../application/service/HumanProjectAuthorizationService.ts";
import {
  GetHumanProjectUseCase,
  HumanAuthorizedUseCase,
  HumanOperatorUseCase,
  ListHumanProjectsUseCase,
} from "../application/usecase/HumanProjectUseCases.ts";
import type { HumanProjectOperation } from "../domain/model/HumanAuth.ts";
import { ProjectAuthorizationService } from "../application/service/ProjectAuthorizationService.ts";
import { RuntimeAuthorizationService } from "../application/service/RuntimeAuthorizationService.ts";
import {
  AuthenticateAccessCredentialUseCase,
  IssueAccessCredentialUseCase,
  ListAccessCredentialsUseCase,
  RevokeAccessCredentialUseCase,
  RotateAccessCredentialUseCase,
} from "../application/usecase/AccessCredentialUseCases.ts";
import { SQLiteAccessCredentialRepository } from "../infrastructure/repository/SQLiteAccessCredentialRepository.ts";
import { GrantProjectRoleUseCase } from "../application/usecase/GrantProjectRoleUseCase.ts";
import {
  CompleteOidcLoginUseCase,
  LocalDevLoginUseCase,
  StartOidcLoginUseCase,
} from "../application/usecase/HumanLoginUseCases.ts";
import {
  GetHumanAuthBootstrapStatusUseCase,
  RegisterOrLoginHumanUseCase,
  ResolveHumanSessionUseCase,
  RevokeHumanSessionUseCase,
} from "../application/usecase/HumanSessionUseCases.ts";
import { ListProjectGrantsUseCase } from "../application/usecase/ListProjectGrantsUseCase.ts";
import {
  ChangeProjectMemberRoleUseCase,
  CreateProjectInvitationUseCase,
  ListProjectInvitationsUseCase,
  ListProjectMembersUseCase,
  RevokeProjectInvitationUseCase,
  RevokeProjectMemberUseCase,
} from "../application/usecase/ProjectMembershipUseCases.ts";
import { RevokeProjectRoleUseCase } from "../application/usecase/RevokeProjectRoleUseCase.ts";
import type { HumanIdentityProvider } from "../application/port/HumanIdentityProvider.ts";
import { SQLiteHumanAccountRepository } from "../infrastructure/repository/SQLiteHumanAccountRepository.ts";
import { SQLiteLoginAttemptRepository } from "../infrastructure/repository/SQLiteLoginAttemptRepository.ts";
import { SQLiteProjectGrantRepository } from "../infrastructure/repository/SQLiteProjectGrantRepository.ts";
import { SQLiteProjectMembershipRepository } from "../infrastructure/repository/SQLiteProjectMembershipRepository.ts";
import type { Kysely } from "kysely";
import { asDirectionDatabase, asWorkDatabase } from "./database/contextDatabase.ts";
import type { Database } from "./database/schema.ts";
import { workExternalReaders } from "../infrastructure/repository/workExternalReaders.ts";
import { writeProjectOwnerMembership } from "../infrastructure/repository/writeProjectOwnerMembership.ts";

/** DBを開かずにUse Caseを組み立てる。containerはimport時にDBを開くため、CLIなどはこちらを使う。 */
export const createApplicationServices = (
  applicationDatabase: Kysely<Database>,
  instructionService: InstructionService = new InstructionService(),
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
  const projectRepository = new SQLiteProjectRepository(directionDatabase, writeProjectOwnerMembership);
  const intentRepository = new SQLiteIntentRepository(directionDatabase);
  const outcomeRepository = new SQLiteOutcomeRepository(directionDatabase);
  const researchRepository = new SQLiteResearchRepository(directionDatabase, clock);
  const directionDecisionRepository = new SQLiteDirectionDecisionRepository(directionDatabase, clock);
  const adrHandoffRepository = new SQLiteAdrHandoffRepository(directionDatabase);
  const runtimeEventRepository = new SQLiteRuntimeEventRepository(directionDatabase);
  const projectGrantRepository = new SQLiteProjectGrantRepository(applicationDatabase, clock);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  // Runtime向けの入口はRuntime Credentialのscopeで認可する（trusted-localのAgent名だけ暫定のruntime Grant）。
  const runtimeAuthorizationService = new RuntimeAuthorizationService(projectAuthorizationService);
  const accessCredentialRepository = new SQLiteAccessCredentialRepository(applicationDatabase);
  // Execution（旧Wachaから移植）。同じDB・同じプロセスの中で動き、Directionの参照は読取専用ポートだけを通す。
  const workStore = new KyselyWorkStore(asWorkDatabase(applicationDatabase), workExternalReaders);
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
  const humanAccountRepository = new SQLiteHumanAccountRepository(applicationDatabase, clock);
  const projectMembershipRepository = new SQLiteProjectMembershipRepository(applicationDatabase, clock);
  const humanProjectAuthorizationService = new HumanProjectAuthorizationService(projectMembershipRepository);
  const loginAttemptRepository = new SQLiteLoginAttemptRepository(applicationDatabase);
  const registerOrLoginHumanUseCase = new RegisterOrLoginHumanUseCase(humanAccountRepository, humanAuth.initialOwnerEmail);
  const identityProvider = humanAuth.identityProvider ?? null;
  const services = {
    instructionService,
    projectAuthorizationService,
    runtimeAuthorizationService,
    taskCoordinationService,
    createProjectUseCase: new CreateProjectUseCase(projectRepository),
    updateProjectUseCase: new UpdateProjectUseCase(projectRepository),
    archiveProjectUseCase: new ArchiveProjectUseCase(projectRepository),
    listProjectsUseCase: new ListProjectsUseCase(projectRepository),
    getProjectUseCase: new GetProjectUseCase(projectRepository),
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
    fetchRuntimeEventsUseCase: new FetchRuntimeEventsUseCase(
      runtimeAuthorizationService,
      projectRepository,
      runtimeEventRepository,
    ),
    ackRuntimeEventUseCase: new AckRuntimeEventUseCase(
      runtimeAuthorizationService,
      projectRepository,
      runtimeEventRepository,
      clock,
    ),
    recordExecutionEvidenceUseCase: new RecordExecutionEvidenceUseCase(
      runtimeAuthorizationService,
      projectRepository,
      outcomeRepository,
      executionSummaryService,
      outcomeExecutionRepository,
      clock,
    ),
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
    getEvaluatorContextUseCase: new GetEvaluatorContextUseCase(
      projectAuthorizationService,
      projectRepository,
      intentRepository,
      outcomeRepository,
      outcomeExecutionRepository,
      outcomeEvaluationRepository,
    ),
    recordOutcomeEvaluationUseCase: new RecordOutcomeEvaluationUseCase(
      projectAuthorizationService,
      projectRepository,
      outcomeRepository,
      outcomeExecutionRepository,
      outcomeEvaluationRepository,
      clock,
    ),
    grantProjectRoleUseCase: new GrantProjectRoleUseCase(projectRepository, projectGrantRepository),
    revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(projectRepository, projectGrantRepository),
    listProjectGrantsUseCase: new ListProjectGrantsUseCase(projectRepository, projectGrantRepository),
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
    getResearcherContextUseCase: new GetResearcherContextUseCase(
      projectAuthorizationService,
      projectRepository,
      intentRepository,
      researchRepository,
    ),
    getStrategistContextUseCase: new GetStrategistContextUseCase(
      projectAuthorizationService,
      projectRepository,
      intentRepository,
      outcomeRepository,
      researchRepository,
      directionDecisionRepository,
      outcomeEvaluationRepository,
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
    listProjects: new ListHumanProjectsUseCase(projectRepository, projectMembershipRepository),
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
  return { ...services, human };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;
