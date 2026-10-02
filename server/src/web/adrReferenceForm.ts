export type AdrReference = {
  id: string;
  projectId: string;
  decisionId: string;
  repositoryId: string;
  path: string;
  commitSha: string;
  pullRequestUrl: string | null;
  correlationId: string;
  principalId: string;
  createdAt: number;
};
