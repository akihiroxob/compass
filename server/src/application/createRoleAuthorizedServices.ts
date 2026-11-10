import { projectWorkspaceId } from "./projectWorkspace.ts";
import { AgentContextService } from "./agentContext/AgentContextService.ts";
import { GetRoleContextUseCase } from "./agentContext/GetRoleContextUseCase.ts";
import { GetWorkspaceRoleContextUseCase } from "./agentContext/GetWorkspaceRoleContextUseCase.ts";
import {
  AckRuntimeEventUseCase,
  DefineIntentMetricUseCase,
  DirectionAgentRole,
  FetchRuntimeEventsUseCase,
  GetEvaluatorContextUseCase,
  GetWorkspaceOrchestrationStateUseCase,
  GetResearcherContextUseCase,
  GetStrategistContextUseCase,
  ListProjectTargetOutcomesUseCase,
  RecordExecutionEvidenceUseCase,
  RecordIntentExplanationUseCase,
  RecordIntentMetricObservationsUseCase,
  RecordOutcomeEvaluationUseCase,
} from "@compass/direction";
import { GetProjectUseCase, GetWorkspaceUseCase, ListWorkspaceProjectsUseCase } from "@compass/organization";
import { RecordPublicationUseCase, TaskCoordinationService } from "@compass/work";
import { RoleScopeAuthorizationService, ProjectAuthorizationService, RuntimeAuthorizationService } from "@compass/access";
import {
  ActivityScope,
  AgentActivityReader,
  GetActivityUseCase,
  ListActivitiesUseCase,
  RecordActivityUseCase,
  type ActivityUnitOfWork,
} from "@compass/activity";
import { AgentConsultationUseCases, type ConsultationScope } from "@compass/collaboration";
import { activityAuthorization } from "./activityAuthorization.ts";
import { consultationAgentAuthorization } from "./consultationAuthorization.ts";
import type { HumanServicesDependencies } from "./createHumanServices.ts";

export interface RoleServicesDependencies {
  getProjectUseCase: GetProjectUseCase;
  consultations: HumanServicesDependencies["consultations"];
  workspaceRepository: ConstructorParameters<typeof GetWorkspaceUseCase>[0];
  projectRepository: ConstructorParameters<typeof GetProjectUseCase>[0];
  recordPublicationUseCase: RecordPublicationUseCase;
  agentContextService: AgentContextService;
  listActivitiesUseCase: ListActivitiesUseCase;
  getActivityUseCase: GetActivityUseCase;
  listWorkspaceActivitiesUseCase: ListActivitiesUseCase;
  getWorkspaceActivityUseCase: GetActivityUseCase;
  activityUnitOfWork: ActivityUnitOfWork;
  clock: () => number;
  workspaceContexts: { getEvaluatorContextUseCase: GetEvaluatorContextUseCase; getResearcherContextUseCase: GetResearcherContextUseCase; getStrategistContextUseCase: GetStrategistContextUseCase };
  workspaceIntentRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[3];
  workspaceOutcomeRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[4] & ConstructorParameters<typeof ListProjectTargetOutcomesUseCase>[0];
  workspaceResearchRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[5];
  workspaceDecisionRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[6];
  outcomeEvaluationRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[7];
  outcomeTargetProjectRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[8];
  outcomeExecutionRepository: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[9];
  executionSummaryService: ConstructorParameters<typeof GetWorkspaceOrchestrationStateUseCase>[10];
  workspaceDirection: { fetchRuntimeEventsUseCase: FetchRuntimeEventsUseCase; ackRuntimeEventUseCase: AckRuntimeEventUseCase; recordExecutionEvidenceUseCase: RecordExecutionEvidenceUseCase; recordOutcomeEvaluationUseCase: RecordOutcomeEvaluationUseCase; defineIntentMetricUseCase: DefineIntentMetricUseCase; recordIntentExplanationUseCase: RecordIntentExplanationUseCase; recordIntentMetricObservationsUseCase: RecordIntentMetricObservationsUseCase };
}

/** 相談のscope。ProjectとWorkspaceは別のscopeで、互いのIDで指しても相談は見つからない。 */
const projectConsultationScope = (projectId: string): ConsultationScope => ({ kind: "project", projectId });
const workspaceConsultationScope = (workspaceId: string): ConsultationScope => ({ kind: "workspace", workspaceId });
export const createRoleAuthorizedServices = (dependencies: RoleServicesDependencies, projectAuthorization: ProjectAuthorizationService, roleScopeAuthorization: RoleScopeAuthorizationService, coordination: TaskCoordinationService) => {
  const { getProjectUseCase, consultations, workspaceRepository, projectRepository, recordPublicationUseCase, agentContextService, listActivitiesUseCase, getActivityUseCase, listWorkspaceActivitiesUseCase, getWorkspaceActivityUseCase, activityUnitOfWork, clock, workspaceContexts, workspaceIntentRepository, workspaceOutcomeRepository, workspaceResearchRepository, workspaceDecisionRepository, outcomeEvaluationRepository, outcomeTargetProjectRepository, outcomeExecutionRepository, executionSummaryService, workspaceDirection } = dependencies;

    // Runtime向けの入口はRuntime Credentialのscopeで認可する（trusted-localのAgent名だけ暫定のruntime Grant）。
    const runtimeAuthorization = new RuntimeAuthorizationService(projectAuthorization);
    const activityAuthorizationPort = activityAuthorization(projectAuthorization, roleScopeAuthorization);
    // Workspace Direction RoleのContext。WorkspaceのRole Grant（activeRoleの指定時はそのRoleだけ）で認可してから読む。
    const workspaceRoleContext = <Args extends unknown[], Result>(
      role: DirectionAgentRole,
      context: { execute(principalId: string, workspaceId: string, ...args: Args): Promise<Result> },
    ) => ({
      execute: async (principal: string | null, workspaceId: string, ...args: Args): Promise<Result> =>
        context.execute(await roleScopeAuthorization.requireRole(principal, { kind: "workspace", id: workspaceId }, role), workspaceId, ...args),
    });
    return {
      projectAuthorizationService: projectAuthorization,
      roleScopeAuthorizationService: roleScopeAuthorization,
      runtimeAuthorizationService: runtimeAuthorization,
      getProjectConsultationStateUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string) => {
          await runtimeAuthorization.requireScope(caller, projectId, "runtime:state:read");
          const project = await getProjectUseCase.execute(projectId);
          const pending = project.status === "active"
            ? await consultations.list.execute(projectConsultationScope(projectId), { status: "waiting_agent" })
            : { consultations: [] };
          return { projectId, workspaceId: project.workspaceId, projectStatus: project.status,
            consultations: pending.consultations.map(({ id, revision }) => ({ id, inputRevision: revision })), observedAt: clock() };
        },
      },
      // Workspace相談の応答待ち（Strategistの起動用）。Workspace Runtime Credentialの`runtime:state:read`だけで認可し、Project Credentialから
      // 継承しない。ID・入力版だけで会話本文を返さない。archivedのWorkspaceは空にする。
      getWorkspaceConsultationStateUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], workspaceId: string) => {
          await runtimeAuthorization.requireWorkspaceScope(caller, workspaceId, "runtime:state:read");
          const workspace = await new GetWorkspaceUseCase(workspaceRepository).execute(workspaceId);
          const pending = workspace.status === "active"
            ? await consultations.list.execute(workspaceConsultationScope(workspaceId), { status: "waiting_agent" })
            : { consultations: [] };
          return { workspaceId, workspaceStatus: workspace.status,
            consultations: pending.consultations.map(({ id, revision }) => ({ id, inputRevision: revision })), observedAt: clock() };
        },
      },
      taskCoordinationService: coordination,
      // Runtime eventはWorkspace所有。Workspace Runtime Credentialのscopeだけで認可し、Project Credentialからは継承しない。
      fetchRuntimeEventsUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], workspaceId: string, input: unknown = {}) => {
          const consumerId = await runtimeAuthorization.requireWorkspaceScope(caller, workspaceId, "runtime:event:read");
          return workspaceDirection.fetchRuntimeEventsUseCase.execute(consumerId, workspaceId, input);
        },
      },
      ackRuntimeEventUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], workspaceId: string, input: unknown) => {
          const consumerId = await runtimeAuthorization.requireWorkspaceScope(caller, workspaceId, "runtime:event:ack");
          return workspaceDirection.ackRuntimeEventUseCase.execute(consumerId, workspaceId, input);
        },
      },
      // Execution EvidenceはProjectのWorkから導出するProject固有の記録。Project Runtime Credentialで認可し、所属Workspaceを明示して還流する。
      recordExecutionEvidenceUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string, outcomeId: string, input: unknown) => {
          const principalId = await runtimeAuthorization.requireScope(caller, projectId, "execution:evidence:write");
          const workspaceId = await projectWorkspaceId(projectRepository, projectId);
          return workspaceDirection.recordExecutionEvidenceUseCase.execute(principalId, workspaceId, projectId, outcomeId, input);
        },
      },
      // 公開確認（Runtime）。Project Runtime Credentialの`publication:write`で認可し、記録した主体を原記録に残す。
      recordPublicationUseCase: {
        execute: async (caller: Parameters<typeof runtimeAuthorization.requireScope>[0], projectId: string, input: unknown) => {
          const principalId = await runtimeAuthorization.requireScope(caller, projectId, "publication:write");
          return recordPublicationUseCase.execute(principalId, projectId, input);
        },
      },
      // Workspace単位の現在状態。Workspace Runtime Credentialのscopeだけで認可し、Project Credentialから継承しない。
      getWorkspaceOrchestrationStateUseCase: new GetWorkspaceOrchestrationStateUseCase(
        runtimeAuthorization,
        workspaceRepository,
        projectRepository,
        workspaceIntentRepository,
        workspaceOutcomeRepository,
        workspaceResearchRepository,
        workspaceDecisionRepository,
        outcomeEvaluationRepository,
        outcomeTargetProjectRepository,
        outcomeExecutionRepository,
        executionSummaryService,
        clock,
      ),
      getEvaluatorContextUseCase: workspaceRoleContext(DirectionAgentRole.EVALUATOR, workspaceContexts.getEvaluatorContextUseCase),
      recordOutcomeEvaluationUseCase: {
        execute: async (principal: string | null, workspaceId: string, outcomeId: string, input: unknown) => {
          const principalId = await roleScopeAuthorization.requireRole(principal, { kind: "workspace", id: workspaceId }, DirectionAgentRole.EVALUATOR);
          return workspaceDirection.recordOutcomeEvaluationUseCase.execute(workspaceId, principalId, outcomeId, input);
        },
      },
      // Intentの観測項目の定義（単位・目標値・鮮度の期限）はStrategist、観測値の記録はEvaluatorのWorkspace Grantで認可する。
      // Project Grantからは継承しない。来歴のPrincipalはBearerから解決した値だけ。
      defineIntentMetricUseCase: {
        execute: async (principal: string | null, workspaceId: string, intentId: string, input: unknown) => {
          const principalId = await roleScopeAuthorization.requireRole(principal, { kind: "workspace", id: workspaceId }, DirectionAgentRole.STRATEGIST);
          return workspaceDirection.defineIntentMetricUseCase.execute(workspaceId, principalId, intentId, input);
        },
      },
      recordIntentExplanationUseCase: {
        execute: async (principal: string | null, workspaceId: string, intentId: string, input: unknown) => {
          const principalId = await roleScopeAuthorization.requireRole(principal, { kind: "workspace", id: workspaceId }, DirectionAgentRole.STRATEGIST);
          return workspaceDirection.recordIntentExplanationUseCase.execute(workspaceId, principalId, intentId, input);
        },
      },
      recordIntentMetricObservationsUseCase: {
        execute: async (principal: string | null, workspaceId: string, intentId: string, input: unknown) => {
          const principalId = await roleScopeAuthorization.requireRole(principal, { kind: "workspace", id: workspaceId }, DirectionAgentRole.EVALUATOR);
          return workspaceDirection.recordIntentMetricObservationsUseCase.execute(workspaceId, principalId, intentId, input);
        },
      },
      getResearcherContextUseCase: workspaceRoleContext(DirectionAgentRole.RESEARCHER, workspaceContexts.getResearcherContextUseCase),
      getRoleContextUseCase: new GetRoleContextUseCase(
        projectAuthorization,
        agentContextService,
        getProjectUseCase,
        new GetWorkspaceUseCase(workspaceRepository),
        new ListProjectTargetOutcomesUseCase(workspaceOutcomeRepository),
        listActivitiesUseCase,
      ),
      // Workspace Role（strategist / researcher / evaluator）のRole Context。Workspace Role Grantで認可し、Project Grantから継承しない。
      getWorkspaceRoleContextUseCase: new GetWorkspaceRoleContextUseCase(
        roleScopeAuthorization,
        agentContextService,
        new GetWorkspaceUseCase(workspaceRepository),
        new ListWorkspaceProjectsUseCase(workspaceRepository, projectRepository),
        listWorkspaceActivitiesUseCase,
      ),
      recordActivityUseCase: new RecordActivityUseCase(ActivityScope.PROJECT, activityAuthorizationPort, activityUnitOfWork, clock),
      agentActivityReader: new AgentActivityReader(ActivityScope.PROJECT, activityAuthorizationPort, listActivitiesUseCase, getActivityUseCase),
      // Workspace Activity（Direction canonical・Workspace Roleの明示記録）。Workspace Role Grantで認可し、Project Grantから継承しない。
      recordWorkspaceActivityUseCase: new RecordActivityUseCase(ActivityScope.WORKSPACE, activityAuthorizationPort, activityUnitOfWork, clock),
      agentWorkspaceActivityReader: new AgentActivityReader(
        ActivityScope.WORKSPACE,
        activityAuthorizationPort,
        listWorkspaceActivitiesUseCase,
        getWorkspaceActivityUseCase,
      ),
      getStrategistContextUseCase: workspaceRoleContext(DirectionAgentRole.STRATEGIST, workspaceContexts.getStrategistContextUseCase),
      // 相談のAgent入口（MCP）。ProjectはExecution Role、WorkspaceはDirection RoleのGrantで認可し、結論は`agent_summary`として記録する。
      agentConsultationUseCases: new AgentConsultationUseCases(consultationAgentAuthorization(roleScopeAuthorization), consultations),
    };
  
};
