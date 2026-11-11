import { createSqliteAccessInfrastructure, type AccessInfrastructure } from "./accessInfrastructure.ts";
import {
  CredentialScopeAuthorization,
  RoleScopeAuthorizationService,
  HumanProjectAuthorizationService,
  ProjectAuthorizationService,
  RegisterOrLoginHumanUseCase,
  HumanWorkspaceAuthorizationService,
  type HumanIdentityProvider,
} from "@compass/access";

import type { Kysely } from "kysely";
import { asAccessDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { accessProjectReaders, accessWorkspaceReaders } from "../infrastructure/repository/contextAdapters.ts";

export const createAccessServices = (applicationDatabase: Kysely<Database>, clock: () => number, humanAuth: { initialOwnerEmail: string | null; identityProvider?: HumanIdentityProvider | null }, infrastructure?: AccessInfrastructure) => {
  // Accessのrepositoryへは同じ接続をAccessのtableの型で渡し、Project状態（Organization）は同じtransactionで読む実装を渡す。
  const accessDatabase = asAccessDatabase(applicationDatabase);
  const accessProjects = accessProjectReaders(accessDatabase);
  const {
    projectGrantRepository, workspaceGrantRepository, agentRunRepository, accessCredentialRepository,
    humanAccountRepository, workspaceMembershipRepository, workspaceInvitationRepository, loginAttemptRepository,
  } = infrastructure ?? createSqliteAccessInfrastructure(accessDatabase, clock);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  const roleScopeAuthorizationService = new RoleScopeAuthorizationService(workspaceGrantRepository, projectGrantRepository);
  const humanProjectAuthorizationService = new HumanProjectAuthorizationService(
    workspaceMembershipRepository,
    accessProjectReaders(accessDatabase),
    accessWorkspaceReaders(accessDatabase),
  );
  const humanWorkspaceAuthorizationService = new HumanWorkspaceAuthorizationService(workspaceMembershipRepository);
  const credentialScopeAuthorization = new CredentialScopeAuthorization(humanProjectAuthorizationService, humanWorkspaceAuthorizationService);
  const registerOrLoginHumanUseCase = new RegisterOrLoginHumanUseCase(humanAccountRepository, humanAuth.initialOwnerEmail);
  const identityProvider = humanAuth.identityProvider ?? null;
  return {
    accessDatabase,
    accessProjects,
    projectGrantRepository,
    projectAuthorizationService,
    workspaceGrantRepository,
    roleScopeAuthorizationService,
    agentRunRepository,
    accessCredentialRepository,
    humanAccountRepository,
    workspaceMembershipRepository,
    humanProjectAuthorizationService,
    workspaceInvitationRepository,
    humanWorkspaceAuthorizationService,
    credentialScopeAuthorization,
    loginAttemptRepository,
    registerOrLoginHumanUseCase,
    identityProvider,
  };
};
