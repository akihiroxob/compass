import {
  CredentialScopeAuthorization,
  SQLiteAgentRunRepository,
  SQLiteWorkspaceGrantRepository,
  RoleScopeAuthorizationService,
  HumanProjectAuthorizationService,
  ProjectAuthorizationService,
  RegisterOrLoginHumanUseCase,
  SQLiteAccessCredentialRepository,
  SQLiteHumanAccountRepository,
  SQLiteLoginAttemptRepository,
  SQLiteProjectGrantRepository,
  SQLiteWorkspaceInvitationRepository,
  SQLiteWorkspaceMembershipRepository,
  HumanWorkspaceAuthorizationService,
  type HumanIdentityProvider,
} from "@compass/access";

import type { Kysely } from "kysely";
import { asAccessDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { accessProjectReaders, accessWorkspaceReaders } from "../infrastructure/repository/contextAdapters.ts";

export const createAccessServices = (applicationDatabase: Kysely<Database>, clock: () => number, humanAuth: { initialOwnerEmail: string | null; identityProvider?: HumanIdentityProvider | null }) => {
  // Accessのrepositoryへは同じ接続をAccessのtableの型で渡し、Project状態（Organization）は同じtransactionで読む実装を渡す。
  const accessDatabase = asAccessDatabase(applicationDatabase);
  const accessProjects = accessProjectReaders(accessDatabase);
  const projectGrantRepository = new SQLiteProjectGrantRepository(accessDatabase, accessProjectReaders, clock);
  const projectAuthorizationService = new ProjectAuthorizationService(projectGrantRepository);
  const workspaceGrantRepository = new SQLiteWorkspaceGrantRepository(accessDatabase, accessWorkspaceReaders, clock);
  const roleScopeAuthorizationService = new RoleScopeAuthorizationService(workspaceGrantRepository, projectGrantRepository);
  const agentRunRepository = new SQLiteAgentRunRepository(accessDatabase, clock);
  const accessCredentialRepository = new SQLiteAccessCredentialRepository(accessDatabase, accessProjectReaders, accessWorkspaceReaders);
  const humanAccountRepository = new SQLiteHumanAccountRepository(
    accessDatabase,
    accessWorkspaceReaders,
    clock,
  );
  // HumanのMembershipはWorkspace単位だけ（ADR 0003）。ProjectのHuman操作は所属WorkspaceのMembershipで認可する。
  const workspaceMembershipRepository = new SQLiteWorkspaceMembershipRepository(
    accessDatabase,
    accessWorkspaceReaders,
    clock,
  );
  const humanProjectAuthorizationService = new HumanProjectAuthorizationService(
    workspaceMembershipRepository,
    accessProjectReaders(accessDatabase),
    accessWorkspaceReaders(accessDatabase),
  );
  const workspaceInvitationRepository = new SQLiteWorkspaceInvitationRepository(accessDatabase, accessWorkspaceReaders, clock);
  const humanWorkspaceAuthorizationService = new HumanWorkspaceAuthorizationService(workspaceMembershipRepository);
  const credentialScopeAuthorization = new CredentialScopeAuthorization(humanProjectAuthorizationService, humanWorkspaceAuthorizationService);
  const loginAttemptRepository = new SQLiteLoginAttemptRepository(accessDatabase);
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
