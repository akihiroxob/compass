import type { ExpressionBuilder, Kysely, Selectable, Transaction } from "kysely";
import type { AccessCredential, CredentialScope, RuntimeScope } from "../domain/AccessCredential.ts";
import type {
  AccessCredentialRepository,
  CredentialForAuthentication,
  IssueCredentialOutcome,
  NewCredential,
  NewCredentialSecret,
  RotateCredentialOutcome,
} from "../domain/AccessCredentialRepository.ts";
import type { AccessCredentialTable, AccessDatabase } from "./schema.ts";
import type { AccessExecutor, AccessProjectReaders } from "./AccessProjectReaders.ts";
import type { AccessWorkspaceReaders } from "./AccessWorkspaceReaders.ts";

/** 最終利用日時の更新間隔。毎回のrequestで書き込まない。 */
const lastUsedResolutionMilliseconds = 60 * 1000;

const toCredential = (row: Selectable<AccessCredentialTable>): AccessCredential => ({
  id: row.id,
  // CHECK制約でscopeに対応するIDの列だけが非NULL。
  scope: { kind: row.scope_kind, id: (row.scope_kind === "workspace" ? row.workspace_id : row.project_id) as string },
  kind: row.kind,
  principalId: row.principal_id,
  scopes: JSON.parse(row.scopes_json) as RuntimeScope[],
  prefix: row.prefix,
  expiresAt: row.expires_at,
  revokedAt: row.revoked_at,
  lastUsedAt: row.last_used_at,
  createdAt: row.created_at,
  createdByHumanUserId: row.created_by_human_user_id,
  rotatedFromId: row.rotated_from_id,
});

const scopeColumns = (scope: CredentialScope) => ({
  scope_kind: scope.kind,
  workspace_id: scope.kind === "workspace" ? scope.id : null,
  project_id: scope.kind === "project" ? scope.id : null,
});

const inScope = (scope: CredentialScope) => (eb: ExpressionBuilder<AccessDatabase, "access_credential">) =>
  eb.and([
    eb("scope_kind", "=", scope.kind),
    eb(scope.kind === "workspace" ? "workspace_id" : "project_id", "=", scope.id),
  ]);

/**
 * Agent Principalが`scope`以外（別Workspace・別Project、WorkspaceとProjectの違いを含む）に、Role Grantまたは
 * 有効なAgent Credentialを持つか。Grant側（`SQLiteProjectGrantRepository`・`SQLiteWorkspaceGrantRepository`）も
 * 同じ束縛を逆向きに検査する。
 */
export const isAgentPrincipalBoundElsewhere = async (
  database: Kysely<AccessDatabase> | Transaction<AccessDatabase>,
  scope: CredentialScope,
  principalId: string,
  now: number,
): Promise<boolean> => {
  let projectGrant = database.selectFrom("project_grant").select("project_id").where("principal_id", "=", principalId);
  if (scope.kind === "project") projectGrant = projectGrant.where("project_id", "!=", scope.id);
  if (await projectGrant.executeTakeFirst()) return true;
  let workspaceGrant = database.selectFrom("workspace_grant").select("workspace_id").where("principal_id", "=", principalId);
  if (scope.kind === "workspace") workspaceGrant = workspaceGrant.where("workspace_id", "!=", scope.id);
  if (await workspaceGrant.executeTakeFirst()) return true;
  return (await findActiveAgentCredentialElsewhere(database, scope, principalId, now)) !== undefined;
};

/** `scope`以外に束縛された有効なAgent Credential。 */
export const findActiveAgentCredentialElsewhere = (
  database: Kysely<AccessDatabase> | Transaction<AccessDatabase>,
  scope: CredentialScope,
  principalId: string,
  now: number,
) =>
  database
    .selectFrom("access_credential")
    .select("id")
    .where("kind", "=", "agent")
    .where("principal_id", "=", principalId)
    .where((eb) => eb.not(inScope(scope)(eb)))
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();

export class SQLiteAccessCredentialRepository implements AccessCredentialRepository {
  constructor(
    private readonly database: Kysely<AccessDatabase>,
    private readonly projects: AccessProjectReaders,
    private readonly workspaces: AccessWorkspaceReaders,
  ) {}

  private isScopeArchived(executor: AccessExecutor, scope: CredentialScope): Promise<boolean> {
    return scope.kind === "workspace"
      ? this.workspaces(executor).isArchived(scope.id)
      : this.projects(executor).isArchived(scope.id);
  }

  async issue(credential: NewCredential): Promise<IssueCredentialOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<IssueCredentialOutcome> => {
      if (await this.isScopeArchived(transaction, credential.scope)) return { kind: "scope_archived" };
      if (
        credential.kind === "agent" &&
        (await isAgentPrincipalBoundElsewhere(transaction, credential.scope, credential.principalId, credential.createdAt))
      ) {
        return { kind: "principal_bound_elsewhere" };
      }
      const row = await transaction
        .insertInto("access_credential")
        .values({
          id: credential.id,
          ...scopeColumns(credential.scope),
          kind: credential.kind,
          principal_id: credential.principalId,
          scopes_json: JSON.stringify(credential.scopes),
          prefix: credential.prefix,
          secret_hash: credential.secretHash,
          expires_at: credential.expiresAt,
          revoked_at: null,
          revoked_by_human_user_id: null,
          last_used_at: null,
          created_at: credential.createdAt,
          created_by_human_user_id: credential.createdByHumanUserId,
          rotated_from_id: null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "issued", credential: toCredential(row) };
    });
  }

  async rotate(
    scope: CredentialScope,
    credentialId: string,
    next: NewCredentialSecret,
    previousExpiresAt: number,
  ): Promise<RotateCredentialOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<RotateCredentialOutcome> => {
      const previous = await transaction
        .selectFrom("access_credential")
        .selectAll()
        .where("id", "=", credentialId)
        .where(inScope(scope))
        .executeTakeFirst();
      if (!previous) return { kind: "not_found" };
      if (await this.isScopeArchived(transaction, scope)) return { kind: "scope_archived" };
      if (previous.revoked_at !== null || previous.expires_at <= next.createdAt) return { kind: "not_active" };

      const row = await transaction
        .insertInto("access_credential")
        .values({
          id: next.id,
          ...scopeColumns(scope),
          kind: previous.kind,
          principal_id: previous.principal_id,
          scopes_json: previous.scopes_json,
          prefix: next.prefix,
          secret_hash: next.secretHash,
          expires_at: next.expiresAt,
          revoked_at: null,
          revoked_by_human_user_id: null,
          last_used_at: null,
          created_at: next.createdAt,
          created_by_human_user_id: next.createdByHumanUserId,
          rotated_from_id: previous.id,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      const shortened = await transaction
        .updateTable("access_credential")
        .set({ expires_at: Math.min(previous.expires_at, previousExpiresAt) })
        .where("id", "=", previous.id)
        .returningAll()
        .executeTakeFirstOrThrow();
      return { kind: "rotated", credential: toCredential(row), previous: toCredential(shortened) };
    });
  }

  async revoke(scope: CredentialScope, credentialId: string, humanUserId: string, now: number): Promise<AccessCredential | null> {
    await this.database
      .updateTable("access_credential")
      .set({ revoked_at: now, revoked_by_human_user_id: humanUserId })
      .where("id", "=", credentialId)
      .where(inScope(scope))
      .where("revoked_at", "is", null)
      .execute();
    return this.findInScope(scope, credentialId);
  }

  async listByScope(scope: CredentialScope): Promise<AccessCredential[]> {
    const rows = await this.database
      .selectFrom("access_credential")
      .selectAll()
      .where(inScope(scope))
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toCredential);
  }

  async findInScope(scope: CredentialScope, id: string): Promise<AccessCredential | null> {
    const row = await this.database
      .selectFrom("access_credential")
      .selectAll()
      .where("id", "=", id)
      .where(inScope(scope))
      .executeTakeFirst();
    return row ? toCredential(row) : null;
  }

  async findForAuthentication(id: string): Promise<CredentialForAuthentication | null> {
    const row = await this.database.selectFrom("access_credential").selectAll().where("id", "=", id).executeTakeFirst();
    return row ? { ...toCredential(row), secretHash: row.secret_hash } : null;
  }

  async recordUse(id: string, now: number): Promise<void> {
    await this.database
      .updateTable("access_credential")
      .set({ last_used_at: now })
      .where("id", "=", id)
      .where((eb) =>
        eb.or([eb("last_used_at", "is", null), eb("last_used_at", "<=", now - lastUsedResolutionMilliseconds)]),
      )
      .execute();
  }
}
