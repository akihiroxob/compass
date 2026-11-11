import type { D1Database } from "@cloudflare/workers-types";
import type { AccessDatabase } from "@compass/access";
import type { Kysely } from "kysely";
import { D1ProjectGrantRepository } from "../infrastructure/repository/d1/D1ProjectGrantRepository.ts";
import { D1WorkspaceGrantRepository } from "../infrastructure/repository/d1/D1WorkspaceGrantRepository.ts";
import { D1AgentRunRepository } from "../infrastructure/repository/d1/D1AgentRunRepository.ts";
import { D1AccessCredentialRepository } from "../infrastructure/repository/d1/D1AccessCredentialRepository.ts";
import { D1HumanAccountRepository } from "../infrastructure/repository/d1/D1HumanAccountRepository.ts";
import { D1WorkspaceMembershipRepository } from "../infrastructure/repository/d1/D1WorkspaceMembershipRepository.ts";
import { D1WorkspaceInvitationRepository } from "../infrastructure/repository/d1/D1WorkspaceInvitationRepository.ts";
import { D1LoginAttemptRepository } from "../infrastructure/repository/d1/D1LoginAttemptRepository.ts";
import type { AccessInfrastructure } from "./accessInfrastructure.ts";

export const createD1AccessInfrastructure = (database: Kysely<AccessDatabase>, binding: D1Database, clock: () => number): AccessInfrastructure => ({
  projectGrantRepository: new D1ProjectGrantRepository(database, binding, clock),
  workspaceGrantRepository: new D1WorkspaceGrantRepository(database, binding, clock),
  agentRunRepository: new D1AgentRunRepository(database, clock),
  accessCredentialRepository: new D1AccessCredentialRepository(database, binding),
  humanAccountRepository: new D1HumanAccountRepository(database, binding, clock),
  workspaceMembershipRepository: new D1WorkspaceMembershipRepository(database, binding, clock),
  workspaceInvitationRepository: new D1WorkspaceInvitationRepository(database, binding, clock),
  loginAttemptRepository: new D1LoginAttemptRepository(database, binding),
});
