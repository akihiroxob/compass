import { CreateProjectUseCase } from "./application/usecase/CreateProjectUseCase.ts";
import { GetProjectUseCase } from "./application/usecase/GetProjectUseCase.ts";
import { UpdateProjectUseCase } from "./application/usecase/UpdateProjectUseCase.ts";
import { ListProjectsUseCase } from "./application/usecase/ListProjectsUseCase.ts";
import { createDatabase } from "./infrastructure/database/createDatabase.ts";
import { initializeSchema } from "./infrastructure/database/initializeSchema.ts";
import { SQLiteProjectRepository } from "./infrastructure/repository/SQLiteProjectRepository.ts";
import type { Kysely } from "kysely";
import type { Database } from "./infrastructure/database/schema.ts";

const database = createDatabase();
await initializeSchema(database);

export const createApplicationServices = (applicationDatabase: Kysely<Database>) => {
  const projectRepository = new SQLiteProjectRepository(applicationDatabase);
  return {
    createProjectUseCase: new CreateProjectUseCase(projectRepository),
    updateProjectUseCase: new UpdateProjectUseCase(projectRepository),
    listProjectsUseCase: new ListProjectsUseCase(projectRepository),
    getProjectUseCase: new GetProjectUseCase(projectRepository),
  };
};

export type ApplicationServices = ReturnType<typeof createApplicationServices>;

export const applicationServices = createApplicationServices(database);
