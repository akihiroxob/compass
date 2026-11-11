import type { IntentRepository, IntentMetricRepository, OutcomeRepository, ResearchRepository, RuntimeEventRepository, OutcomeTargetProjectRepository } from "@compass/direction";
import { type OrganizationInfrastructure } from "./organizationInfrastructure.ts";

import { systemActivityActor } from "../application/activityActor.ts";
import { activityActorContext } from "../infrastructure/activity/NodeActivityActorContext.ts";

import {
  AbandonIntentUseCase,
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
  GetIntentUseCase,
  GetOutcomeUseCase,
  GetResearchRequestUseCase,
  ListIntentRevisionsUseCase,
  type DirectionActorPort,
  ListAdrReferencesUseCase,
  ListDirectionDecisionsUseCase,
  ListIntentsUseCase,
  ListOutcomeTargetProjectsUseCase,
  ListOutcomesUseCase,
  ListResearchRequestsUseCase,
  RecordAdrReferenceUseCase,
  RegisterResearchResultUseCase,
  RegisterResearchSynthesisUseCase,
  UnsetOutcomeTargetProjectUseCase,
  SQLiteAdrHandoffRepository,
  SQLiteDirectionDecisionRepository,
  SQLiteIntentExplanationRepository,
  SQLiteIntentMetricRepository,
  SQLiteIntentRepository,
  SQLiteOutcomeEvaluationRepository,
  SQLiteOutcomeExecutionRepository,
  SQLiteOutcomeRepository,
  SQLiteOutcomeTargetProjectRepository,
  SQLiteResearchRepository,
  SQLiteRuntimeEventRepository,
  UpdateIntentUseCase,
  UpdateOutcomeUseCase,
} from "@compass/direction";

import type { Kysely } from "kysely";
import { asDirectionDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { directionChangeObserver, directionProjectReaders, directionWorkspaceReaders } from "../infrastructure/repository/contextAdapters.ts";

export type DirectionRepositoryOverrides = {
  intentRepository?: IntentRepository;
  outcomeRepository?: OutcomeRepository;
  intentMetricRepository?: IntentMetricRepository;
  researchRepository?: ResearchRepository;
  runtimeEventRepository?: RuntimeEventRepository;
  outcomeTargetProjectRepository?: OutcomeTargetProjectRepository;
};

export const createDirectionFoundation = (applicationDatabase: Kysely<Database>, workspaceRepository: OrganizationInfrastructure["workspaceRepository"], clock: () => number, infrastructure: DirectionRepositoryOverrides = {}) => {
  // Directionのrepositoryへは同じ接続を、自身のtable型で渡す。Workspace/Project状態は同じtransactionで読むreaderを渡す。
  const directionDatabase = asDirectionDatabase(applicationDatabase);
  // Directionの重要な状態変更も、同じtransactionでcanonical Activityへ投影する。
  const workspaceIntentRepository = infrastructure.intentRepository ?? new SQLiteIntentRepository(directionDatabase, directionWorkspaceReaders, directionChangeObserver);
  const workspaceOutcomeRepository = infrastructure.outcomeRepository ?? new SQLiteOutcomeRepository(directionDatabase, directionWorkspaceReaders, directionChangeObserver);
  // Target ProjectとOutcomeのWorkspace一致は、書込と同じtransactionでProject（Organization）を読んで検査する。
  const outcomeTargetProjectRepository = infrastructure.outcomeTargetProjectRepository ?? new SQLiteOutcomeTargetProjectRepository(directionDatabase, directionProjectReaders, directionWorkspaceReaders, clock);
  // 変更主体は、認可済みの入口（Web UIのHuman操作・MCPのAgent操作）が固定した主体。特定できない保守呼出しは`system`。
  const directionActor: DirectionActorPort = { current: () => activityActorContext.current() ?? systemActivityActor };
  const workspaceBasics = {
    createIntentUseCase: new CreateIntentUseCase(workspaceRepository, workspaceIntentRepository, directionActor),
    listIntentRevisionsUseCase: new ListIntentRevisionsUseCase(workspaceRepository, workspaceIntentRepository),
    listIntentsUseCase: new ListIntentsUseCase(workspaceRepository, workspaceIntentRepository),
    getIntentUseCase: new GetIntentUseCase(workspaceRepository, workspaceIntentRepository),
    updateIntentUseCase: new UpdateIntentUseCase(workspaceRepository, workspaceIntentRepository, directionActor),
    abandonIntentUseCase: new AbandonIntentUseCase(workspaceRepository, workspaceIntentRepository),
    createOutcomeUseCase: new CreateOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
    listOutcomesUseCase: new ListOutcomesUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository),
    getOutcomeUseCase: new GetOutcomeUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository),
    updateOutcomeUseCase: new UpdateOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
    cancelOutcomeUseCase: new CancelOutcomeUseCase(workspaceRepository, workspaceOutcomeRepository),
    setOutcomeTargetProjectUseCase: new SetOutcomeTargetProjectUseCase(workspaceRepository, outcomeTargetProjectRepository),
    unsetOutcomeTargetProjectUseCase: new UnsetOutcomeTargetProjectUseCase(workspaceRepository, outcomeTargetProjectRepository),
    listOutcomeTargetProjectsUseCase: new ListOutcomeTargetProjectsUseCase(workspaceRepository, outcomeTargetProjectRepository),
  };
  const workspaceResearchRepository = infrastructure.researchRepository ?? new SQLiteResearchRepository(
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
  const runtimeEventRepository = infrastructure.runtimeEventRepository ?? new SQLiteRuntimeEventRepository(directionDatabase);
  const outcomeExecutionRepository = new SQLiteOutcomeExecutionRepository(directionDatabase, directionProjectReaders, directionWorkspaceReaders);
  const outcomeEvaluationRepository = new SQLiteOutcomeEvaluationRepository(
    directionDatabase,
    directionWorkspaceReaders,
    directionProjectReaders,
    directionChangeObserver,
  );
  const intentMetricRepository = infrastructure.intentMetricRepository ?? new SQLiteIntentMetricRepository(directionDatabase, directionWorkspaceReaders);
  const intentExplanationRepository = new SQLiteIntentExplanationRepository(directionDatabase, directionWorkspaceReaders);
  return {
    directionDatabase,
    workspaceIntentRepository,
    workspaceOutcomeRepository,
    outcomeTargetProjectRepository,
    directionActor,
    workspaceBasics,
    workspaceResearchRepository,
    workspaceDecisionRepository,
    adrHandoffRepository,
    workspaceDirectionBasics,
    runtimeEventRepository,
    outcomeExecutionRepository,
    outcomeEvaluationRepository,
    intentMetricRepository,
    intentExplanationRepository,
  };
};
