export const intentPath = (projectId: string, intentId?: string, suffix = "") =>
  `/projects/${projectId}/intents${intentId ? `/${intentId}` : ""}${suffix}`;

export const outcomePath = (projectId: string, intentId: string, outcomeId?: string, suffix = "") =>
  `${intentPath(projectId, intentId)}/outcomes${outcomeId ? `/${outcomeId}` : ""}${suffix}`;
