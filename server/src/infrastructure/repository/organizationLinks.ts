import { writeWorkspaceOwnerMembership } from "@compass/access";
import { findAdrReferencedRepositoryId } from "@compass/direction";
import { type WorkspaceOwnerMembershipWriter, type ProjectRepositoryReferenceFinder } from "@compass/organization";
import { asAccessTransaction, asDirectionDatabase } from "../database/contextDatabase.ts";

/** OrganizationのWorkspace作成（Projectと同時の作成を含む）のtransactionで、作成者の初期owner Membership（Access）を書く。 */
export const workspaceOwnerMembershipWriter: WorkspaceOwnerMembershipWriter = (transaction, input) =>
  writeWorkspaceOwnerMembership(asAccessTransaction(transaction), input);

/** OrganizationがRepositoryを外すtransactionで、ADR Handoff Request/Reference（Direction）からの参照を読む。 */
export const projectRepositoryReferenceFinder: ProjectRepositoryReferenceFinder = (transaction, repositoryIds) =>
  findAdrReferencedRepositoryId(asDirectionDatabase(transaction), repositoryIds);
