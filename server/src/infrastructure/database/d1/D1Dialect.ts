import {
  Kysely, SqliteAdapter, SqliteIntrospector, SqliteQueryCompiler,
  type CompiledQuery, type DatabaseConnection, type Dialect, type Driver, type QueryResult,
} from "kysely";
import type { D1Database, D1DatabaseSession } from "@cloudflare/workers-types";
import type { Database } from "../schema.ts";

export class D1InteractiveTransactionUnsupportedError extends Error {
  constructor() {
    super("D1 requires an atomic batch with explicit SQL preconditions; callback transactions are not supported");
    this.name = "D1InteractiveTransactionUnsupportedError";
  }
}

export type D1ReadExecutor = <R>(query: CompiledQuery, execute: () => Promise<QueryResult<R>>) => Promise<QueryResult<R>>;
export type D1QueryOptions = { readOnly?: boolean; readExecutor?: D1ReadExecutor };

class D1Connection implements DatabaseConnection {
  constructor(private readonly session: D1DatabaseSession, private readonly options: D1QueryOptions) {}

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    if (this.options.readOnly && query.query.kind !== "SelectQueryNode") throw new Error("Planned D1 reads cannot execute direct SQL mutations");
    if (this.options.readExecutor) return this.options.readExecutor(query, () => this.executeDirect<R>(query));
    return this.executeDirect<R>(query);
  }

  private async executeDirect<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    const result = await this.session.prepare(query.sql).bind(...query.parameters).all<R>();
    if (!result.success) throw new Error(result.error ?? "D1 query failed");
    return {
      rows: result.results,
      numAffectedRows: BigInt(result.meta.changes),
      insertId: BigInt(result.meta.last_row_id),
    };
  }

  async *streamQuery<R>(): AsyncIterableIterator<QueryResult<R>> {
    throw new Error("D1 does not support streaming SQL query results");
  }
}

class D1Driver implements Driver {
  constructor(private readonly binding: D1Database, private readonly options: D1QueryOptions) {}
  async init() {}
  async acquireConnection() {
    // 最初のqueryをprimaryへ送り、この接続内の読取りの順序を維持する。
    return new D1Connection(this.binding.withSession("first-primary"), this.options);
  }
  async beginTransaction(): Promise<never> { throw new D1InteractiveTransactionUnsupportedError(); }
  async commitTransaction(): Promise<never> { throw new D1InteractiveTransactionUnsupportedError(); }
  async rollbackTransaction(): Promise<never> { throw new D1InteractiveTransactionUnsupportedError(); }
  async releaseConnection() {}
  async destroy() {}
}

/** SQLite実装のtransactionを無効化して流用せず、D1用Repositoryの単一queryとSQL生成に使う。 */
export class D1Dialect implements Dialect {
  constructor(private readonly binding: D1Database, private readonly options: D1QueryOptions = {}) {}
  createDriver() { return new D1Driver(this.binding, this.options); }
  createAdapter() { return new SqliteAdapter(); }
  createQueryCompiler() { return new SqliteQueryCompiler(); }
  createIntrospector(database: Kysely<any>) { return new SqliteIntrospector(database); }
}

export const createD1Database = (binding: D1Database, options: D1QueryOptions = {}) => new Kysely<Database>({ dialect: new D1Dialect(binding, options) });
