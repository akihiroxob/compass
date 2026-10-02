import type { ProjectRole } from "../../constants/ProjectRole.ts";

export type ProjectGrantProperties = {
  projectId: string;
  principalId: string;
  role: ProjectRole;
  createdAt: number;
};

/** 「このPrincipalがこのProjectでこのRoleを担ってよい」という認可の記録。Agentの起動やRunの所有は表さない。 */
export class ProjectGrant {
  readonly projectId: string;
  readonly principalId: string;
  readonly role: ProjectRole;
  readonly createdAt: number;

  constructor(properties: ProjectGrantProperties) {
    this.projectId = properties.projectId;
    this.principalId = properties.principalId;
    this.role = properties.role;
    this.createdAt = properties.createdAt;
  }
}
