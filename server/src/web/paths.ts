export const intentPath = (projectId: string, intentId?: string, suffix = "") =>
  `/projects/${projectId}/intents${intentId ? `/${intentId}` : ""}${suffix}`;

export const outcomePath = (projectId: string, intentId: string, outcomeId?: string, suffix = "") =>
  `${intentPath(projectId, intentId)}/outcomes${outcomeId ? `/${outcomeId}` : ""}${suffix}`;

export const researchRequestPath = (projectId: string, requestId: string) =>
  `/projects/${projectId}/research/${requestId}`;

export const taskPath = (projectId: string, taskId: string) => `/projects/${projectId}/tasks/${taskId}`;
export const taskEditPath = (projectId: string, taskId: string) => `${taskPath(projectId, taskId)}/edit`;
export const taskCreatePath = (projectId: string, storyId?: string) =>
  `/projects/${projectId}/tasks/new${storyId ? `?storyId=${encodeURIComponent(storyId)}` : ""}`;
export const storyCreatePath = (projectId: string) => `/projects/${projectId}/stories/new`;
export const storyEditPath = (projectId: string, storyId: string) => `/projects/${projectId}/stories/${storyId}/edit`;
