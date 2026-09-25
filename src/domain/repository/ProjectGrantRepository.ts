import type { ProjectRole } from "../../constants/ProjectRole.ts";
import type { ProjectGrant } from "../model/ProjectGrant.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";

export type GrantResult = { grant: ProjectGrant; created: boolean };

/** Projectがarchivedなら、書込と同一transactionで検査して`project_archived`を返し、何も書かない。 */
/**
 * `principal_bound_elsewhere`: そのPrincipalは別Projectの有効なAgent Credentialに束縛されている（Task 37）。
 * 別ProjectのAdministratorが発行したCredentialで、このProjectの権限を得させないため何も書かない。
 */
export type GrantOutcome =
  | ({ kind: "granted" } & GrantResult)
  | { kind: "principal_bound_elsewhere" }
  | ProjectArchivedResult;
export type RevokeOutcome = { kind: "revoked"; revoked: boolean } | ProjectArchivedResult;

export interface ProjectGrantRepository {
  /** 同じ(projectId, principalId, role)が既にあれば新規作成せず、既存のGrant（createdAt不変）を返す。 */
  grant(projectId: string, principalId: string, role: ProjectRole): Promise<GrantOutcome>;
  /** `revoked`は、削除したらtrue。存在しないGrantの取消はfalse（冪等）。他Project・他Roleの同名Grantには影響しない。 */
  revoke(projectId: string, principalId: string, role: ProjectRole): Promise<RevokeOutcome>;
  hasRole(projectId: string, principalId: string, role: ProjectRole): Promise<boolean>;
  /** いずれかのRole Grantを持つか。 */
  hasAnyRole(projectId: string, principalId: string): Promise<boolean>;
  /** いずれかのRole Grantを持つProjectのID。 */
  listProjectIds(principalId: string): Promise<string[]>;
  /** roleとprincipalIdの昇順。 */
  listByProject(projectId: string): Promise<ProjectGrant[]>;
}
