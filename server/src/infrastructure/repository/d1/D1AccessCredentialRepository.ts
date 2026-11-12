import type { D1Database } from "@cloudflare/workers-types";
import { sql, type CompiledQuery, type Kysely } from "kysely";
import {
  SQLiteAccessCredentialRepository, accessCredentialFromRow, accessCredentialScopeColumns, accessCredentialInScope,
  agentPrincipalBindingQueries, isAgentPrincipalBoundElsewhere,
  type AccessDatabase, type AccessCredentialRepository, type CredentialScope, type NewCredential, type NewCredentialSecret,
  type IssueCredentialOutcome, type RotateCredentialOutcome, type AccessCredentialTable,
} from "@compass/access";
import { ConflictError } from "@compass/shared";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import { accessProjectReaders, accessWorkspaceReaders } from "../accessReaders.ts";

type CredentialReads = Pick<AccessCredentialRepository, "revoke" | "listByScope" | "findInScope" | "findForAuthentication" | "recordUse">;

export class D1AccessCredentialRepository implements AccessCredentialRepository {
  private readonly atomic: D1AtomicBatch;
  private readonly reader: CredentialReads;

  constructor(private readonly database: Kysely<AccessDatabase>, binding: D1Database) {
    this.atomic = new D1AtomicBatch(binding);
    this.reader = new SQLiteAccessCredentialRepository(database, accessProjectReaders, accessWorkspaceReaders);
  }

  async issue(credential: NewCredential): Promise<IssueCredentialOutcome> {
    const guards: CompiledQuery[] = [this.writableScope(credential.scope).compile()];
    if (credential.kind === "agent") {
      guards.push(...agentPrincipalBindingQueries(this.database, credential.scope, credential.principalId, credential.createdAt)
        .map((query) => sql`SELECT 1 WHERE NOT EXISTS ${query}`.compile(this.database)));
    }
    try {
      const [result] = await this.atomic.execute(guards, [this.database.insertInto("access_credential").values({
        id: credential.id, ...accessCredentialScopeColumns(credential.scope), kind: credential.kind,
        principal_id: credential.principalId, scopes_json: JSON.stringify(credential.scopes), prefix: credential.prefix,
        secret_hash: credential.secretHash, expires_at: credential.expiresAt, created_at: credential.createdAt,
        created_by_human_user_id: credential.createdByHumanUserId, revoked_at: null, revoked_by_human_user_id: null,
        last_used_at: null, rotated_from_id: null,
      }).returningAll().compile()]);
      return { kind: "issued", credential: accessCredentialFromRow(result!.results[0] as AccessCredentialTable) };
    } catch (error) {
      if (!(error instanceof D1PreconditionFailedError)) throw error;
      if (!await this.writableScope(credential.scope).executeTakeFirst()) return { kind: "scope_archived" };
      if (credential.kind === "agent" && await isAgentPrincipalBoundElsewhere(this.database, credential.scope, credential.principalId, credential.createdAt)) {
        return { kind: "principal_bound_elsewhere" };
      }
      throw new ConflictError("Credential issuance preconditions changed", { scopeKind: credential.scope.kind, scopeId: credential.scope.id });
    }
  }

  async rotate(scope: CredentialScope, credentialId: string, next: NewCredentialSecret, previousExpiresAt: number): Promise<RotateCredentialOutcome> {
    const query = this.database.selectFrom("access_credential").selectAll().where("id", "=", credentialId).where(accessCredentialInScope(scope));
    for (let attempt = 0; attempt < 3; attempt++) {
      const previous = await query.executeTakeFirst();
      if (!previous) return { kind: "not_found" };
      if (!await this.writableScope(scope).executeTakeFirst()) return { kind: "scope_archived" };
      if (previous.revoked_at !== null || previous.expires_at <= next.createdAt) return { kind: "not_active" };
      const snapshot = query.where("revoked_at", "is", null).where("expires_at", "=", previous.expires_at)
        .where("secret_hash", "=", previous.secret_hash).where("kind", "=", previous.kind)
        .where("principal_id", "=", previous.principal_id).where("scopes_json", "=", previous.scopes_json);
      try {
        const results = await this.atomic.execute([this.writableScope(scope).compile(), snapshot.compile()], [
          this.database.insertInto("access_credential").values({ id: next.id, ...accessCredentialScopeColumns(scope), kind: previous.kind,
            principal_id: previous.principal_id, scopes_json: previous.scopes_json, prefix: next.prefix, secret_hash: next.secretHash,
            expires_at: next.expiresAt, created_at: next.createdAt, created_by_human_user_id: next.createdByHumanUserId,
            revoked_at: null, revoked_by_human_user_id: null, last_used_at: null, rotated_from_id: previous.id }).returningAll().compile(),
          this.database.updateTable("access_credential").set({ expires_at: Math.min(previous.expires_at, previousExpiresAt) })
            .where("id", "=", credentialId).returningAll().compile(),
        ]);
        return { kind: "rotated", credential: accessCredentialFromRow(results[0]!.results[0] as AccessCredentialTable),
          previous: accessCredentialFromRow(results[1]!.results[0] as AccessCredentialTable) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Credential changed repeatedly during rotation", { credentialId });
  }

  revoke(scope: CredentialScope, id: string, humanId: string, now: number) { return this.reader.revoke(scope, id, humanId, now); }
  listByScope(scope: CredentialScope) { return this.reader.listByScope(scope); }
  findInScope(scope: CredentialScope, id: string) { return this.reader.findInScope(scope, id); }
  findForAuthentication(id: string) { return this.reader.findForAuthentication(id); }
  recordUse(id: string, now: number) { return this.reader.recordUse(id, now); }

  private writableScope(scope: CredentialScope) {
    const organization = asOrganizationDatabase(this.database);
    const archived = scope.kind === "project"
      ? organization.selectFrom("project").select("id").where("id", "=", scope.id).where("status", "=", "archived")
      : organization.selectFrom("workspace").select("id").where("id", "=", scope.id).where("status", "=", "archived");
    return organization.selectNoFrom(sql<number>`1`.as("writable")).where(sql<boolean>`NOT EXISTS ${archived}`);
  }
}
