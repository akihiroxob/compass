import { createDirectionFoundation } from "./directionFoundation.ts";

import { createWorkServices } from "./workServices.ts";

import { OutcomeDeliveryReader } from "../infrastructure/repository/OutcomeDeliveryReader.ts";
import { OutcomeProblemReader } from "../infrastructure/repository/OutcomeProblemReader.ts";
import { type OrganizationInfrastructure } from "./organizationInfrastructure.ts";

import {
  AckRuntimeEventUseCase,
  DefineIntentMetricUseCase,
  FetchRuntimeEventsUseCase,
  GetEvaluatorContextUseCase,
  GetExecutionSummaryUseCase,
  GetResearcherContextUseCase,
  GetStrategistContextUseCase,
  ListIntentExplanationsUseCase,
  ListIntentMetricsUseCase,
  ListOutcomeEvaluationsUseCase,
  ListOutcomeTargetExecutionsUseCase,
  ListOutcomeTargetWorkUseCase,
  ListWorkspaceOutcomesUseCase,
  GetWorkspaceOutcomeOverviewUseCase,
  ListRuntimeEventsUseCase,
  RecordExecutionEvidenceUseCase,
  RecordIntentExplanationUseCase,
  RecordIntentMetricObservationsUseCase,
  RecordOutcomeEvaluationUseCase,
} from "@compass/direction";

import { KyselyConsultationStore } from "@compass/collaboration";
import type { Kysely } from "kysely";
import { asCollaborationDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";

export const createDirectionServices = (applicationDatabase: Kysely<Database>, organization: OrganizationInfrastructure, foundation: ReturnType<typeof createDirectionFoundation>, work: ReturnType<typeof createWorkServices>, clock: () => number) => {
  const { projectRepository, workspaceRepository } = organization;
  const {
    workspaceIntentRepository,
    workspaceOutcomeRepository,
    outcomeTargetProjectRepository,
    workspaceResearchRepository,
    workspaceDecisionRepository,
    workspaceDirectionBasics,
    runtimeEventRepository,
    outcomeExecutionRepository,
    outcomeEvaluationRepository,
    intentMetricRepository,
    intentExplanationRepository,
  } = foundation;
  const { workStore, listProjectReleasesUseCase, executionSummaryService } = work;
  const outcomeProblemReader = new OutcomeProblemReader(workStore, new KyselyConsultationStore(asCollaborationDatabase(applicationDatabase)));
  const outcomeDeliveryReader = new OutcomeDeliveryReader((projectId) => listProjectReleasesUseCase.execute(projectId));
  const workspaceContexts = {
    getResearcherContextUseCase: new GetResearcherContextUseCase(workspaceRepository, workspaceIntentRepository, workspaceResearchRepository),
    getStrategistContextUseCase: new GetStrategistContextUseCase(workspaceRepository, workspaceIntentRepository, workspaceOutcomeRepository,
      workspaceResearchRepository, workspaceDecisionRepository, outcomeEvaluationRepository, projectRepository, outcomeTargetProjectRepository),
    getEvaluatorContextUseCase: new GetEvaluatorContextUseCase(workspaceRepository, workspaceIntentRepository,
      workspaceOutcomeRepository, outcomeTargetProjectRepository, outcomeExecutionRepository, outcomeEvaluationRepository),
  };
  // Human認証・Membership（docs/step-6-human-auth-design.md）。Agent GrantのRepository・認可とは分離する。
  const workspaceDirection = {
    ...workspaceDirectionBasics,
    recordOutcomeEvaluationUseCase: new RecordOutcomeEvaluationUseCase(workspaceRepository, workspaceOutcomeRepository,
      outcomeTargetProjectRepository, outcomeExecutionRepository, outcomeEvaluationRepository, clock),
    listOutcomeEvaluationsUseCase: new ListOutcomeEvaluationsUseCase(workspaceRepository, workspaceOutcomeRepository, outcomeEvaluationRepository),
    recordExecutionEvidenceUseCase: new RecordExecutionEvidenceUseCase(projectRepository, workspaceOutcomeRepository,
      executionSummaryService, outcomeExecutionRepository, clock),
    getExecutionSummaryUseCase: new GetExecutionSummaryUseCase(projectRepository, workspaceOutcomeRepository, outcomeExecutionRepository),
    // Target別のWork要約。WorkのStory / Taskは読取専用ポートで数えるだけで、Directionへ複製しない。
    listOutcomeTargetWorkUseCase: new ListOutcomeTargetWorkUseCase(workspaceRepository, workspaceIntentRepository,
      workspaceOutcomeRepository, outcomeTargetProjectRepository, executionSummaryService),
    // Workspace横断のOutcome一覧と詳細の集計。同じ組み立てでTask進捗（Work）と問題（相談）を読取専用ポートから集める。
    listWorkspaceOutcomesUseCase: new ListWorkspaceOutcomesUseCase(workspaceRepository, workspaceIntentRepository,
      workspaceOutcomeRepository, outcomeTargetProjectRepository, executionSummaryService, outcomeProblemReader, outcomeEvaluationRepository, outcomeDeliveryReader),
    getWorkspaceOutcomeOverviewUseCase: new GetWorkspaceOutcomeOverviewUseCase(workspaceRepository, workspaceIntentRepository,
      workspaceOutcomeRepository, outcomeTargetProjectRepository, executionSummaryService, outcomeProblemReader, outcomeEvaluationRepository, outcomeDeliveryReader),
    // Target別に還流済みのExecution Summary・Evidence参照（Directionが保存した記録だけを読む）。
    listOutcomeTargetExecutionsUseCase: new ListOutcomeTargetExecutionsUseCase(workspaceRepository, workspaceOutcomeRepository,
      outcomeTargetProjectRepository, outcomeExecutionRepository),
    listRuntimeEventsUseCase: new ListRuntimeEventsUseCase(workspaceRepository, runtimeEventRepository),
    fetchRuntimeEventsUseCase: new FetchRuntimeEventsUseCase(workspaceRepository, runtimeEventRepository),
    ackRuntimeEventUseCase: new AckRuntimeEventUseCase(workspaceRepository, runtimeEventRepository, clock),
    // Intentの観測項目と時系列。定義はStrategist、記録はEvaluator、参照はWorkspaceの参照者（認可は入口側）。
    defineIntentMetricUseCase: new DefineIntentMetricUseCase(workspaceRepository, intentMetricRepository, clock),
    recordIntentMetricObservationsUseCase: new RecordIntentMetricObservationsUseCase(workspaceRepository, intentMetricRepository, clock),
    listIntentMetricsUseCase: new ListIntentMetricsUseCase(workspaceRepository, intentMetricRepository, clock),
    // 観測項目についてのAgentの説明（事実・仮説・提案）。記録はStrategist、参照はWorkspaceの参照者（認可は入口側）。
    recordIntentExplanationUseCase: new RecordIntentExplanationUseCase(workspaceRepository, intentExplanationRepository, clock),
    listIntentExplanationsUseCase: new ListIntentExplanationsUseCase(workspaceRepository, intentExplanationRepository, intentMetricRepository, clock),
  };
  return { workspaceContexts, workspaceDirection };
};
