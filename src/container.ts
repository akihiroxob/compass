import { AbandonIntentUseCase } from "./application/usecase/AbandonIntentUseCase.ts";
import { CancelOutcomeUseCase } from "./application/usecase/CancelOutcomeUseCase.ts";
import { CreateIntentUseCase } from "./application/usecase/CreateIntentUseCase.ts";
import { CreateOutcomeUseCase } from "./application/usecase/CreateOutcomeUseCase.ts";
import { GetIntentUseCase } from "./application/usecase/GetIntentUseCase.ts";
import { GetOutcomeUseCase } from "./application/usecase/GetOutcomeUseCase.ts";
import { ListIntentsUseCase } from "./application/usecase/ListIntentsUseCase.ts";
import { ListOutcomesUseCase } from "./application/usecase/ListOutcomesUseCase.ts";
import { UpdateIntentUseCase } from "./application/usecase/UpdateIntentUseCase.ts";
import { UpdateOutcomeUseCase } from "./application/usecase/UpdateOutcomeUseCase.ts";
import { CreateProjectUseCase } from "./application/usecase/CreateProjectUseCase.ts";
import { GetProjectUseCase } from "./application/usecase/GetProjectUseCase.ts";
import { UpdateProjectUseCase } from "./application/usecase/UpdateProjectUseCase.ts";
import { ListProjectsUseCase } from "./application/usecase/ListProjectsUseCase.ts";
import { createDatabase } from "./infrastructure/database/createDatabase.ts";
import { initializeSchema } from "./infrastructure/database/initializeSchema.ts";
import { SQLiteIntentRepository } from "./infrastructure/repository/SQLiteIntentRepository.ts";
import { SQLiteOutcomeRepository } from "./infrastructure/repository/SQLiteOutcomeRepository.ts";
import { SQLiteProjectRepository } from "./infrastructure/repository/SQLiteProjectRepository.ts";
import type { Kysely } from "kysely";
import type { Database } from "./infrastructure/database/schema.ts";

const database = createDatabase();
await initializeSchema(database);

export const createApplicationServices = (applicationDatabase: Kysely<Database>) => {
  const projectRepository = new SQLiteProjectRepository(applicationDatabase);
  const intentRepository = new SQLiteIntentRepository(applicationDatabase);
  const outcomeRepository = new SQLiteOutcomeRepository(applicationDatabase);
  return {
    createProjectUseCase: new CreateProjectUseCase(projectRepository),
    updateProjectUseCase: new UpdateProjectUseCase(projectRepository),
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
  };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;

export const applicationServices = createApplicationServices(database);
