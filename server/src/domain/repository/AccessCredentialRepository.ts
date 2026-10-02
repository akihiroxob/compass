import type { AccessCredential, CredentialKind, RuntimeScope } from "../model/AccessCredential.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";

export type NewCredentialSecret = {
  id: string;
  prefix: string;
  secretHash: string;
  expiresAt: number;
  createdAt: number;
  createdByHumanUserId: string;
};

export type NewCredential = NewCredentialSecret & {
  projectId: string;
  kind: CredentialKind;
  principalId: string;
  scopes: RuntimeScope[];
};

/**
 * Agent Credentialは発行したProjectに束縛する。同じPrincipalが別ProjectのRole Grant、または別Projectの
 * 有効なAgent Credentialを持つ場合は`principal_bound_elsewhere`で何も書かない（別Projectの権限を得させない）。
 */
export type IssueCredentialOutcome =
  | { kind: "issued"; credential: AccessCredential }
  | { kind: "principal_bound_elsewhere" }
  | ProjectArchivedResult;

export type RotateCredentialOutcome =
  | { kind: "rotated"; credential: AccessCredential; previous: AccessCredential }
  | { kind: "not_found" }
  /** 取消済み・期限切れはrotationできない（新しく発行する）。 */
  | { kind: "not_active" }
  | ProjectArchivedResult;

export type CredentialForAuthentication = AccessCredential & { secretHash: string };

export interface AccessCredentialRepository {
  /** 検査（archived・Principalの束縛）と書込を同一transactionで行う。 */
  issue(credential: NewCredential): Promise<IssueCredentialOutcome>;
  /**
   * 旧Credentialと同じkind・Principal・scopesで新Credentialを作り、旧Credentialの期限を`previousExpiresAt`
   * までに縮める（それより短い期限は延ばさない）。旧Credentialが有効な間だけ行える。
   */
  rotate(
    projectId: string,
    credentialId: string,
    next: NewCredentialSecret,
    previousExpiresAt: number,
  ): Promise<RotateCredentialOutcome>;
  /** 冪等。取消済みなら最初の取消を返す。archivedのProjectでも取消できる。別ProjectのIDは`null`。 */
  revoke(projectId: string, credentialId: string, humanUserId: string, now: number): Promise<AccessCredential | null>;
  /** 新しい順。secret hashを含まない。 */
  listByProject(projectId: string): Promise<AccessCredential[]>;
  findInProject(projectId: string, id: string): Promise<AccessCredential | null>;
  findForAuthentication(id: string): Promise<CredentialForAuthentication | null>;
  /** 最終利用日時。書込を抑えるため、前回から一定時間経った場合だけ更新する。 */
  recordUse(id: string, now: number): Promise<void>;
}
