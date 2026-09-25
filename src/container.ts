import { createApplicationServices } from "./createApplicationServices.ts";
import { createDatabase } from "./infrastructure/database/createDatabase.ts";
import { initializeSchema } from "./infrastructure/database/initializeSchema.ts";

export { createApplicationServices, type ApplicationServices } from "./createApplicationServices.ts";

const database = createDatabase();
await initializeSchema(database);

export const applicationServices = createApplicationServices(database);
