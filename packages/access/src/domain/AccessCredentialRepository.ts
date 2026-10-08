import type { AccessCredential, CredentialKind, CredentialScope, RuntimeScope } from "./AccessCredential.ts";

export type NewCredentialSecret = {
  id: string;
  prefix: string;
  secretHash: string;
  expiresAt: number;
  createdAt: number;
  createdByHumanUserId: string;
};

export type NewCredential = NewCredentialSecret & {
  scope: CredentialScope;
  kind: CredentialKind;
  principalId: string;
  scopes: RuntimeScope[];
};

/** 書込と同一transactionの検査で、Credentialのscope（Workspace / Project）がarchivedだった。何も書かない。 */
export type CredentialScopeArchivedResult = { kind: "scope_archived" };

/**
 * Agent Credentialは発行したscopeに束縛する。同じPrincipalが別scope（別Workspace・別Project、WorkspaceとProjectの
 * 違いを含む）のRole Grant、または有効なAgent Credentialを持つ場合は`principal_bound_elsewhere`で何も書かない。
 */
export type IssueCredentialOutcome =
  | { kind: "issued"; credential: AccessCredential }
  | { kind: "principal_bound_elsewhere" }
  | CredentialScopeArchivedResult;

export type RotateCredentialOutcome =
  | { kind: "rotated"; credential: AccessCredential; previous: AccessCredential }
  | { kind: "not_found" }
  /** 取消済み・期限切れはrotationできない（新しく発行する）。 */
  | { kind: "not_active" }
  | CredentialScopeArchivedResult;

export type CredentialForAuthentication = AccessCredential & { secretHash: string };

export interface AccessCredentialRepository {
  /** 検査（archived・Principalの束縛）と書込を同一transactionで行う。scopeが存在することは呼出し側が確認済み。 */
  issue(credential: NewCredential): Promise<IssueCredentialOutcome>;
  /**
   * 旧Credentialと同じkind・Principal・scopesで新Credentialを作り、旧Credentialの期限を`previousExpiresAt`
   * までに縮める（それより短い期限は延ばさない）。旧Credentialが有効な間だけ行える。
   */
  rotate(
    scope: CredentialScope,
    credentialId: string,
    next: NewCredentialSecret,
    previousExpiresAt: number,
  ): Promise<RotateCredentialOutcome>;
  /** 冪等。取消済みなら最初の取消を返す。archivedのscopeでも取消できる。別scopeのIDは`null`。 */
  revoke(scope: CredentialScope, credentialId: string, humanUserId: string, now: number): Promise<AccessCredential | null>;
  /** 新しい順。secret hashを含まない。 */
  listByScope(scope: CredentialScope): Promise<AccessCredential[]>;
  findInScope(scope: CredentialScope, id: string): Promise<AccessCredential | null>;
  findForAuthentication(id: string): Promise<CredentialForAuthentication | null>;
  /** 最終利用日時。書込を抑えるため、前回から一定時間経った場合だけ更新する。 */
  recordUse(id: string, now: number): Promise<void>;
}
