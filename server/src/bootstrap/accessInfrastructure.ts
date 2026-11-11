import {
  SQLiteAgentRunRepository, SQLiteWorkspaceGrantRepository, SQLiteAccessCredentialRepository, SQLiteHumanAccountRepository,
  SQLiteLoginAttemptRepository, SQLiteProjectGrantRepository, SQLiteWorkspaceInvitationRepository, SQLiteWorkspaceMembershipRepository,
  type AgentRunRepository, type WorkspaceGrantRepository, type AccessCredentialRepository, type HumanAccountRepository,
  type LoginAttemptRepository, type ProjectGrantRepository, type WorkspaceInvitationRepository, type WorkspaceMembershipRepository,
  type AccessDatabase,
} from "@compass/access";
import type { Kysely } from "kysely";
import { accessProjectReaders, accessWorkspaceReaders } from "../infrastructure/repository/accessReaders.ts";

export interface AccessInfrastructure {
  projectGrantRepository: ProjectGrantRepository;
  workspaceGrantRepository: WorkspaceGrantRepository;
  agentRunRepository: AgentRunRepository;
  accessCredentialRepository: AccessCredentialRepository;
  humanAccountRepository: HumanAccountRepository;
  workspaceMembershipRepository: WorkspaceMembershipRepository;
  workspaceInvitationRepository: WorkspaceInvitationRepository;
  loginAttemptRepository: LoginAttemptRepository;
}

export const createSqliteAccessInfrastructure = (database: Kysely<AccessDatabase>, clock: () => number): AccessInfrastructure => ({
  projectGrantRepository: new SQLiteProjectGrantRepository(database, accessProjectReaders, clock),
  workspaceGrantRepository: new SQLiteWorkspaceGrantRepository(database, accessWorkspaceReaders, clock),
  agentRunRepository: new SQLiteAgentRunRepository(database, clock),
  accessCredentialRepository: new SQLiteAccessCredentialRepository(database, accessProjectReaders, accessWorkspaceReaders),
  humanAccountRepository: new SQLiteHumanAccountRepository(database, accessWorkspaceReaders, clock),
  workspaceMembershipRepository: new SQLiteWorkspaceMembershipRepository(database, accessWorkspaceReaders, clock),
  workspaceInvitationRepository: new SQLiteWorkspaceInvitationRepository(database, accessWorkspaceReaders, clock),
  loginAttemptRepository: new SQLiteLoginAttemptRepository(database),
});
