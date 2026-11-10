import type { GetExecutionSummaryUseCase } from "@compass/direction";
import type { ListWorkspaceProjectsUseCase, ProjectRepository } from "@compass/organization";
import { credentialStatus, type AccessCredentialRepository } from "@compass/access";
import { projectWorkspaceId } from "./projectWorkspace.ts";

/** Project固有の記録を、所属Workspaceを明示してDirectionから読む。 */
export const createProjectExecutionSummaryReader = (
  projects: ProjectRepository,
  summary: Pick<GetExecutionSummaryUseCase, "execute">,
) => ({
  execute: async (projectId: string, outcomeId: string) =>
    summary.execute(await projectWorkspaceId(projects, projectId), projectId, outcomeId),
});

/** リリース履歴に渡す公開観測の可否。現在有効なRuntime Credentialだけを根拠にする。 */
export const createPublicationAvailabilityReader = (
  credentials: Pick<AccessCredentialRepository, "listByScope">,
  clock: () => number,
) => async (projectId: string) => {
  const now = clock();
  return (await credentials.listByScope({ kind: "project", id: projectId })).some((credential) =>
    credential.kind === "runtime" && credential.scopes.includes("publication:write") && credentialStatus(credential, now) === "active");
};

/** Agent実行観測へ渡す所属Projectの識別子。 */
export const createWorkspaceProjectIdsReader = (projects: Pick<ListWorkspaceProjectsUseCase, "execute">) =>
  async (workspaceId: string) => (await projects.execute(workspaceId)).map(({ id }) => id);
