import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { ActivityActorContext } from "../application/activityActor.ts";
import { asAccessDatabase, asActivityDatabase, asDirectionDatabase, asOrganizationDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { D1ProjectRepository } from "../infrastructure/repository/d1/D1ProjectRepository.ts";
import { D1WorkspaceRepository } from "../infrastructure/repository/d1/D1WorkspaceRepository.ts";
import { planD1WorkspaceOwnerMembership } from "../infrastructure/repository/d1/planD1WorkspaceOwnerMembership.ts";
import { createD1ProjectReferenceChecks, planD1ProjectArchiveActivity } from "../infrastructure/repository/d1/projectD1Links.ts";
import type { OrganizationInfrastructure } from "./organizationInfrastructure.ts";

export const createD1OrganizationInfrastructure = (
  database: Kysely<Database>, binding: D1Database, actors: ActivityActorContext, clock: () => number = Date.now,
): OrganizationInfrastructure => {
  const organization = asOrganizationDatabase(database);
  const workspaceRepository = new D1WorkspaceRepository(organization, binding,
    planD1WorkspaceOwnerMembership(asAccessDatabase(database)), clock);
  const projectRepository = new D1ProjectRepository(organization, binding, workspaceRepository,
    createD1ProjectReferenceChecks(asDirectionDatabase(database)), planD1ProjectArchiveActivity(asActivityDatabase(database), actors), clock);
  return { workspaceRepository, projectRepository };
};
