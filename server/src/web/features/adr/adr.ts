export type AdrReference = {
  id: string;
  workspaceId: string;
  projectId: string;
  decisionId: string;
  repositoryId: string;
  path: string;
  commitSha: string;
  pullRequestUrl: string | null;
  correlationId: string;
  requestKey: string;
  principalId: string;
  createdAt: number;
};
