import type { createRoleAuthorizedServices } from "./createRoleAuthorizedServices.ts";
import type { createHumanServices } from "./createHumanServices.ts";
import type { AgentContextService } from "./agentContext/AgentContextService.ts";
import type {
  AbandonIntentUseCase,
  AckRuntimeEventUseCase,
  SetOutcomeTargetProjectUseCase,
  CancelOutcomeUseCase,
  CancelResearchRequestUseCase,
  CompleteResearchRequestUseCase,
  CreateAdrHandoffRequestUseCase,
  CreateDirectionDecisionUseCase,
  CreateIntentUseCase,
  CreateOutcomeUseCase,
  CreateResearchRequestUseCase,
  DecideNextOutcomeUseCase,
  DefineIntentMetricUseCase,
  FetchRuntimeEventsUseCase,
  GetEvaluatorContextUseCase,
  GetExecutionSummaryUseCase,
  GetIntentUseCase,
  GetOutcomeUseCase,
  GetResearcherContextUseCase,
  GetResearchRequestUseCase,
  GetStrategistContextUseCase,
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
  ListRuntimeEventsUseCase,
  RecordAdrReferenceUseCase,
  RecordExecutionEvidenceUseCase,
  RecordIntentExplanationUseCase,
  RecordIntentMetricObservationsUseCase,
  RecordOutcomeEvaluationUseCase,
  RegisterResearchResultUseCase,
  RegisterResearchSynthesisUseCase,
  UnsetOutcomeTargetProjectUseCase,
  UpdateIntentUseCase,
  UpdateOutcomeUseCase,
} from "@compass/direction";
import type { ArchiveProjectUseCase, CreateProjectUseCase, GetProjectUseCase, ListProjectsUseCase, UpdateProjectUseCase } from "@compass/organization";
import type { GetExecutionTaskUseCase, ListExecutionUseCase, SearchExecutionWorkUseCase, ListRecentExecutionChangesUseCase } from "@compass/work";
import type {
  AuthenticateAccessCredentialUseCase,
  CompleteOidcLoginUseCase,
  CreateWorkspaceInvitationUseCase,
  GetHumanAuthBootstrapStatusUseCase,
  GrantWorkspaceRoleUseCase,
  RevokeWorkspaceRoleUseCase,
  ListWorkspaceGrantsUseCase,
  ListWorkspaceAgentRunsUseCase,
  RecordAgentRunUseCase,
  GrantProjectRoleUseCase,
  HumanProjectAuthorizationService,
  IssueAccessCredentialUseCase,
  ListAccessCredentialsUseCase,
  ListProjectGrantsUseCase,
  ListWorkspaceInvitationsUseCase,
  LocalDevLoginUseCase,
  RegisterOrLoginHumanUseCase,
  ResolveHumanSessionUseCase,
  RevokeAccessCredentialUseCase,
  RevokeHumanSessionUseCase,
  RevokeWorkspaceInvitationUseCase,
  RevokeProjectRoleUseCase,
  RotateAccessCredentialUseCase,
  StartOidcLoginUseCase,
  HumanWorkspaceAuthorizationService,
  ProjectRole,
} from "@compass/access";
import type { ActivityActorContext } from "./activityActor.ts";

export interface BaseServices {
  agentContextService: AgentContextService;
  createProjectUseCase: CreateProjectUseCase;
  updateProjectUseCase: UpdateProjectUseCase;
  archiveProjectUseCase: ArchiveProjectUseCase;
  listProjectsUseCase: ListProjectsUseCase;
  getProjectUseCase: GetProjectUseCase;
  createIntentUseCase: CreateIntentUseCase;
  listIntentsUseCase: ListIntentsUseCase;
  getIntentUseCase: GetIntentUseCase;
  updateIntentUseCase: UpdateIntentUseCase;
  listIntentRevisionsUseCase: ListIntentRevisionsUseCase;
  abandonIntentUseCase: AbandonIntentUseCase;
  createOutcomeUseCase: CreateOutcomeUseCase;
  listOutcomesUseCase: ListOutcomesUseCase;
  getOutcomeUseCase: GetOutcomeUseCase;
  updateOutcomeUseCase: UpdateOutcomeUseCase;
  cancelOutcomeUseCase: CancelOutcomeUseCase;
  setOutcomeTargetProjectUseCase: SetOutcomeTargetProjectUseCase;
  unsetOutcomeTargetProjectUseCase: UnsetOutcomeTargetProjectUseCase;
  listOutcomeTargetProjectsUseCase: ListOutcomeTargetProjectsUseCase;
  listOutcomeTargetWorkUseCase: ListOutcomeTargetWorkUseCase;
  listWorkspaceOutcomesUseCase: ListWorkspaceOutcomesUseCase;
  getWorkspaceOutcomeOverviewUseCase: GetWorkspaceOutcomeOverviewUseCase;
  listOutcomeTargetExecutionsUseCase: ListOutcomeTargetExecutionsUseCase;
  createResearchRequestUseCase: CreateResearchRequestUseCase;
  listResearchRequestsUseCase: ListResearchRequestsUseCase;
  getResearchRequestUseCase: GetResearchRequestUseCase;
  registerResearchResultUseCase: RegisterResearchResultUseCase;
  registerResearchSynthesisUseCase: RegisterResearchSynthesisUseCase;
  completeResearchRequestUseCase: CompleteResearchRequestUseCase;
  cancelResearchRequestUseCase: CancelResearchRequestUseCase;
  listOutcomeEvaluationsUseCase: ListOutcomeEvaluationsUseCase;
  createDirectionDecisionUseCase: CreateDirectionDecisionUseCase;
  decideNextOutcomeUseCase: DecideNextOutcomeUseCase;
  listDirectionDecisionsUseCase: ListDirectionDecisionsUseCase;
  listIntentMetricsUseCase: ListIntentMetricsUseCase;
  listIntentExplanationsUseCase: ListIntentExplanationsUseCase;
  createAdrHandoffRequestUseCase: CreateAdrHandoffRequestUseCase;
  recordAdrReferenceUseCase: RecordAdrReferenceUseCase;
  listAdrReferencesUseCase: ListAdrReferencesUseCase;
  getExecutionSummaryUseCase: { execute(projectId: string, outcomeId: string): ReturnType<GetExecutionSummaryUseCase["execute"]> };
  listExecutionUseCase: ListExecutionUseCase;
  searchExecutionWorkUseCase: SearchExecutionWorkUseCase;
  getExecutionTaskUseCase: GetExecutionTaskUseCase;
  listRecentExecutionChangesUseCase: ListRecentExecutionChangesUseCase;
  grantWorkspaceRoleUseCase: GrantWorkspaceRoleUseCase;
  revokeWorkspaceRoleUseCase: RevokeWorkspaceRoleUseCase;
  listWorkspaceGrantsUseCase: ListWorkspaceGrantsUseCase;
  recordAgentRunUseCase: RecordAgentRunUseCase;
  listWorkspaceAgentRunsUseCase: ListWorkspaceAgentRunsUseCase;
  grantProjectRoleUseCase: GrantProjectRoleUseCase;
  revokeProjectRoleUseCase: RevokeProjectRoleUseCase;
  listProjectGrantsUseCase: ListProjectGrantsUseCase;
  humanProjectAuthorizationService: HumanProjectAuthorizationService;
  humanWorkspaceAuthorizationService: HumanWorkspaceAuthorizationService;
  authenticateAccessCredentialUseCase: AuthenticateAccessCredentialUseCase;
  issueAccessCredentialUseCase: IssueAccessCredentialUseCase;
  rotateAccessCredentialUseCase: RotateAccessCredentialUseCase;
  revokeAccessCredentialUseCase: RevokeAccessCredentialUseCase;
  listAccessCredentialsUseCase: ListAccessCredentialsUseCase;
  registerOrLoginHumanUseCase: RegisterOrLoginHumanUseCase;
  getHumanAuthBootstrapStatusUseCase: GetHumanAuthBootstrapStatusUseCase;
  startOidcLoginUseCase: StartOidcLoginUseCase | null;
  completeOidcLoginUseCase: CompleteOidcLoginUseCase | null;
  localDevLoginUseCase: LocalDevLoginUseCase;
  resolveHumanSessionUseCase: ResolveHumanSessionUseCase;
  revokeHumanSessionUseCase: RevokeHumanSessionUseCase;
  createWorkspaceInvitationUseCase: CreateWorkspaceInvitationUseCase;
  listWorkspaceInvitationsUseCase: ListWorkspaceInvitationsUseCase;
  revokeWorkspaceInvitationUseCase: RevokeWorkspaceInvitationUseCase;
}

export interface WorkspaceDirectionServices {
  createIntentUseCase: CreateIntentUseCase;
  listIntentRevisionsUseCase: ListIntentRevisionsUseCase;
  listIntentsUseCase: ListIntentsUseCase;
  getIntentUseCase: GetIntentUseCase;
  updateIntentUseCase: UpdateIntentUseCase;
  abandonIntentUseCase: AbandonIntentUseCase;
  createOutcomeUseCase: CreateOutcomeUseCase;
  listOutcomesUseCase: ListOutcomesUseCase;
  getOutcomeUseCase: GetOutcomeUseCase;
  updateOutcomeUseCase: UpdateOutcomeUseCase;
  cancelOutcomeUseCase: CancelOutcomeUseCase;
  setOutcomeTargetProjectUseCase: SetOutcomeTargetProjectUseCase;
  unsetOutcomeTargetProjectUseCase: UnsetOutcomeTargetProjectUseCase;
  listOutcomeTargetProjectsUseCase: ListOutcomeTargetProjectsUseCase;
  createAdrHandoffRequestUseCase: CreateAdrHandoffRequestUseCase;
  recordAdrReferenceUseCase: RecordAdrReferenceUseCase;
  listAdrReferencesUseCase: ListAdrReferencesUseCase;
  createResearchRequestUseCase: CreateResearchRequestUseCase;
  listResearchRequestsUseCase: ListResearchRequestsUseCase;
  getResearchRequestUseCase: GetResearchRequestUseCase;
  registerResearchResultUseCase: RegisterResearchResultUseCase;
  registerResearchSynthesisUseCase: RegisterResearchSynthesisUseCase;
  completeResearchRequestUseCase: CompleteResearchRequestUseCase;
  cancelResearchRequestUseCase: CancelResearchRequestUseCase;
  createDirectionDecisionUseCase: CreateDirectionDecisionUseCase;
  decideNextOutcomeUseCase: DecideNextOutcomeUseCase;
  listDirectionDecisionsUseCase: ListDirectionDecisionsUseCase;
  recordOutcomeEvaluationUseCase: RecordOutcomeEvaluationUseCase;
  listOutcomeEvaluationsUseCase: ListOutcomeEvaluationsUseCase;
  recordExecutionEvidenceUseCase: RecordExecutionEvidenceUseCase;
  getExecutionSummaryUseCase: GetExecutionSummaryUseCase;
  listOutcomeTargetWorkUseCase: ListOutcomeTargetWorkUseCase;
  listWorkspaceOutcomesUseCase: ListWorkspaceOutcomesUseCase;
  getWorkspaceOutcomeOverviewUseCase: GetWorkspaceOutcomeOverviewUseCase;
  listOutcomeTargetExecutionsUseCase: ListOutcomeTargetExecutionsUseCase;
  listRuntimeEventsUseCase: ListRuntimeEventsUseCase;
  fetchRuntimeEventsUseCase: FetchRuntimeEventsUseCase;
  ackRuntimeEventUseCase: AckRuntimeEventUseCase;
  defineIntentMetricUseCase: DefineIntentMetricUseCase;
  recordIntentMetricObservationsUseCase: RecordIntentMetricObservationsUseCase;
  listIntentMetricsUseCase: ListIntentMetricsUseCase;
  recordIntentExplanationUseCase: RecordIntentExplanationUseCase;
  listIntentExplanationsUseCase: ListIntentExplanationsUseCase;
  getResearcherContextUseCase: GetResearcherContextUseCase;
  getStrategistContextUseCase: GetStrategistContextUseCase;
  getEvaluatorContextUseCase: GetEvaluatorContextUseCase;
}

export type OperationServices = BaseServices & ReturnType<typeof createRoleAuthorizedServices> & {
  activityActorContext: ActivityActorContext;
  human: ReturnType<typeof createHumanServices>;
};

export type ApplicationServices = OperationServices & {
  workspaceDirection: WorkspaceDirectionServices;
  forActiveRole(activeRole: ProjectRole): OperationServices;
};
