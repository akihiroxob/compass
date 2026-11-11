import { CompiledQuery, type QueryResult } from "kysely";
import type { D1ReadExecutor } from "./D1Dialect.ts";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** 読取SQLと同じ結果（空集合・集計・順序を含む）を、確定時のSQL条件にする。 */
export const d1ReadResultGuard = (query: CompiledQuery, rows: readonly unknown[]): CompiledQuery => {
  if (!rows.length) return CompiledQuery.raw(`SELECT 1 WHERE NOT EXISTS (${query.sql})`, [...query.parameters]);
  const keys = Object.keys(rows[0] as object);
  const fields = keys.flatMap((key) => [literal(key), `snapshot.${identifier(key)}`]).join(", ");
  return CompiledQuery.raw(`SELECT 1 WHERE (SELECT json_group_array(json_object(${fields})) FROM (${query.sql}) AS snapshot) = ?`,
    [...query.parameters, JSON.stringify(rows)]);
};

/** 計画中の読取を再利用し、同時変更によるwrite skew・追加行の見落としをcommit時に拒否する。 */
export class D1ReadSet {
  readonly guards: CompiledQuery[] = [];
  private readonly cache = new Map<string, QueryResult<unknown>>();

  readonly execute: D1ReadExecutor = async <R>(query: CompiledQuery, execute: () => Promise<QueryResult<R>>) => {
    const key = JSON.stringify([query.sql, query.parameters]);
    const cached = this.cache.get(key);
    if (cached) return structuredClone(cached) as QueryResult<R>;
    const result = await execute();
    this.guards.push(d1ReadResultGuard(query, result.rows));
    this.cache.set(key, structuredClone(result));
    return result;
  };
}
