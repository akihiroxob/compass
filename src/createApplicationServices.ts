import { InstructionService } from "./application/service/InstructionService.ts";
import { ProjectAuthorizationService } from "./application/service/ProjectAuthorizationService.ts";
import { AbandonIntentUseCase } from "./application/usecase/AbandonIntentUseCase.ts";
import { ArchiveProjectUseCase } from "./application/usecase/ArchiveProjectUseCase.ts";
import { CancelOutcomeUseCase } from "./application/usecase/CancelOutcomeUseCase.ts";
import {
  CancelResearchRequestUseCase,
  CompleteResearchRequestUseCase,
} from "./application/usecase/CloseResearchRequestUseCases.ts";
import { CreateDirectionDecisionUseCase } from "./application/usecase/CreateDirectionDecisionUseCase.ts";
import { CreateIntentUseCase } from "./application/usecase/CreateIntentUseCase.ts";
import { CreateOutcomeUseCase } from "./application/usecase/CreateOutcomeUseCase.ts";
import { CreateProjectUseCase } from "./application/usecase/CreateProjectUseCase.ts";
import { CreateResearchRequestUseCase } from "./application/usecase/CreateResearchRequestUseCase.ts";
import { DecideNextOutcomeUseCase } from "./application/usecase/DecideNextOutcomeUseCase.ts";
import { GetIntentUseCase } from "./application/usecase/GetIntentUseCase.ts";
import { GetOutcomeUseCase } from "./application/usecase/GetOutcomeUseCase.ts";
import { GetResearchRequestUseCase } from "./application/usecase/GetResearchRequestUseCase.ts";
import { GetResearcherContextUseCase } from "./application/usecase/GetResearcherContextUseCase.ts";
import { GetStrategistContextUseCase } from "./application/usecase/GetStrategistContextUseCase.ts";
import { GetProjectUseCase } from "./application/usecase/GetProjectUseCase.ts";
import { GrantProjectRoleUseCase } from "./application/usecase/GrantProjectRoleUseCase.ts";
import { ListIntentsUseCase } from "./application/usecase/ListIntentsUseCase.ts";
import { ListOutcomesUseCase } from "./application/usecase/ListOutcomesUseCase.ts";
import { ListProjectGrantsUseCase } from "./application/usecase/ListProjectGrantsUseCase.ts";
import { ListProjectsUseCase } from "./application/usecase/ListProjectsUseCase.ts";
import { ListResearchRequestsUseCase } from "./application/usecase/ListResearchRequestsUseCase.ts";
import { ListRuntimeEventsUseCase } from "./application/usecase/ListRuntimeEventsUseCase.ts";
import { RegisterResearchResultUseCase } from "./application/usecase/RegisterResearchResultUseCase.ts";
import { RegisterResearchSynthesisUseCase } from "./application/usecase/RegisterResearchSynthesisUseCase.ts";
import { RevokeProjectRoleUseCase } from "./application/usecase/RevokeProjectRoleUseCase.ts";
import { UpdateIntentUseCase } from "./application/usecase/UpdateIntentUseCase.ts";
import { UpdateOutcomeUseCase } from "./application/usecase/UpdateOutcomeUseCase.ts";
import { UpdateProjectUseCase } from "./application/usecase/UpdateProjectUseCase.ts";
import { SQLiteDirectionDecisionRepository } from "./infrastructure/repository/SQLiteDirectionDecisionRepository.ts";
import { SQLiteIntentRepository } from "./infrastructure/repository/SQLiteIntentRepository.ts";
import { SQLiteOutcomeRepository } from "./infrastructure/repository/SQLiteOutcomeRepository.ts";
import { SQLiteProjectGrantRepository } from "./infrastructure/repository/SQLiteProjectGrantRepository.ts";
import { SQLiteProjectRepository } from "./infrastructure/repository/SQLiteProjectRepository.ts";
import { SQLiteResearchRepository } from "./infrastructure/repository/SQLiteResearchRepository.ts";
import { SQLiteRuntimeEventRepository } from "./infrastructure/repository/SQLiteRuntimeEventRepository.ts";
import type { Kysely } from "kysely";
import type { Database } from "./infrastructure/database/schema.ts";

/** DBを開かずにUse Caseを組み立てる。containerはimport時にDBを開くため、CLIなどはこちらを使う。 */
export const createApplicationServices = (
  applicationDatabase: Kysely<Database>,
  instructionService: InstructionService = new InstructionService(),
  /** Researchの期限判定の時刻源。テストで固定できるよう注入する。 */
  clock: () => number = Date.now,
) => {
  const projectRepository = new SQLiteProjectRepository(applicationDatabase);
  const intentRepository = new SQLiteIntentRepository(applicationDatabase);
  const outcomeRepository = new SQLiteOutcomeRepository(applicationDatabase);
  const researchRepository = new SQLiteResearchRepository(applicationDatabase, clock);
  const directionDecisionRepository = new SQLiteDirectionDecisionRepository(applicationDatabase);
  const runtimeEventRepository = new SQLiteRuntimeEventRepository(applicationDatabase);
  const projectGrantRepository = new SQLiteProjectGrantRepository(applicationDatabase);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  return {
    instructionService,
    projectAuthorizationService,
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
    grantProjectRoleUseCase: new GrantProjectRoleUseCase(projectRepository, projectGrantRepository),
    revokeProjectRoleUseCase: new RevokeProjectRoleUseCase(projectRepository, projectGrantRepository),
    listProjectGrantsUseCase: new ListProjectGrantsUseCase(projectRepository, projectGrantRepository),
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
  };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;
