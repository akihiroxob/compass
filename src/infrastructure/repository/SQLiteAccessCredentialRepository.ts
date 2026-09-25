import type { Kysely, Selectable, Transaction } from "kysely";
import type { AccessCredential, RuntimeScope } from "../../domain/model/AccessCredential.ts";
import type {
  AccessCredentialRepository,
  CredentialForAuthentication,
  IssueCredentialOutcome,
  NewCredential,
  NewCredentialSecret,
  RotateCredentialOutcome,
} from "../../domain/repository/AccessCredentialRepository.ts";
import type { AccessCredentialTable, Database } from "../database/schema.ts";
import { isProjectArchived } from "./isProjectArchived.ts";

/** 最終利用日時の更新間隔。毎回のrequestで書き込まない。 */
const lastUsedResolutionMilliseconds = 60 * 1000;

const toCredential = (row: Selectable<AccessCredentialTable>): AccessCredential => ({
  id: row.id,
  projectId: row.project_id,
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

/**
 * Agent PrincipalがprojectId以外のProjectに、Role Grantまたは有効なAgent Credentialを持つか。
 * Grant側（`SQLiteProjectGrantRepository.grant`）も同じ束縛を逆向きに検査する。
 */
export const isAgentPrincipalBoundElsewhere = async (
  database: Kysely<Database> | Transaction<Database>,
  projectId: string,
  principalId: string,
  now: number,
): Promise<boolean> => {
  const grant = await database
    .selectFrom("project_grant")
    .select("project_id")
    .where("principal_id", "=", principalId)
    .where("project_id", "!=", projectId)
    .executeTakeFirst();
  if (grant) return true;
  return (await findActiveAgentCredentialElsewhere(database, projectId, principalId, now)) !== undefined;
};

export const findActiveAgentCredentialElsewhere = (
  database: Kysely<Database> | Transaction<Database>,
  projectId: string,
  principalId: string,
  now: number,
) =>
  database
    .selectFrom("access_credential")
    .select("id")
    .where("kind", "=", "agent")
    .where("principal_id", "=", principalId)
    .where("project_id", "!=", projectId)
    .where("revoked_at", "is", null)
    .where("expires_at", ">", now)
    .executeTakeFirst();

export class SQLiteAccessCredentialRepository implements AccessCredentialRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async issue(credential: NewCredential): Promise<IssueCredentialOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<IssueCredentialOutcome> => {
      if (await isProjectArchived(transaction, credential.projectId)) return { kind: "project_archived" };
      if (
        credential.kind === "agent" &&
        (await isAgentPrincipalBoundElsewhere(transaction, credential.projectId, credential.principalId, credential.createdAt))
      ) {
        return { kind: "principal_bound_elsewhere" };
      }
      const row = await transaction
        .insertInto("access_credential")
        .values({
          id: credential.id,
          project_id: credential.projectId,
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
    projectId: string,
    credentialId: string,
    next: NewCredentialSecret,
    previousExpiresAt: number,
  ): Promise<RotateCredentialOutcome> {
    return this.database.transaction().execute(async (transaction): Promise<RotateCredentialOutcome> => {
      const previous = await transaction
        .selectFrom("access_credential")
        .selectAll()
        .where("id", "=", credentialId)
        .where("project_id", "=", projectId)
        .executeTakeFirst();
      if (!previous) return { kind: "not_found" };
      if (await isProjectArchived(transaction, projectId)) return { kind: "project_archived" };
      if (previous.revoked_at !== null || previous.expires_at <= next.createdAt) return { kind: "not_active" };

      const row = await transaction
        .insertInto("access_credential")
        .values({
          id: next.id,
          project_id: projectId,
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

  async revoke(projectId: string, credentialId: string, humanUserId: string, now: number): Promise<AccessCredential | null> {
    await this.database
      .updateTable("access_credential")
      .set({ revoked_at: now, revoked_by_human_user_id: humanUserId })
      .where("id", "=", credentialId)
      .where("project_id", "=", projectId)
      .where("revoked_at", "is", null)
      .execute();
    const row = await this.database
      .selectFrom("access_credential")
      .selectAll()
      .where("id", "=", credentialId)
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return row ? toCredential(row) : null;
  }

  async listByProject(projectId: string): Promise<AccessCredential[]> {
    const rows = await this.database
      .selectFrom("access_credential")
      .selectAll()
      .where("project_id", "=", projectId)
      .orderBy("created_at", "desc")
      .orderBy("id", "asc")
      .execute();
    return rows.map(toCredential);
  }

  async findInProject(projectId: string, id: string): Promise<AccessCredential | null> {
    const row = await this.database
      .selectFrom("access_credential")
      .selectAll()
      .where("id", "=", id)
      .where("project_id", "=", projectId)
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
