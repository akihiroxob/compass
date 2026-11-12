import { CompiledQuery, type QueryResult } from "kysely";
import type { D1ReadExecutor } from "./D1Dialect.ts";

const identifier = (value: string) => `"${value.replaceAll('"', '""')}"`;
const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const maximumSnapshotBytes = 250_000;
const encoder = new TextEncoder();

const rowObject = (keys: string[]) => {
  const parts: string[] = [];
  // D1の関数引数は32個まで。nullを消すjson_patchは使わず、objectの中身を連結する。
  for (let offset = 0; offset < keys.length; offset += 16) {
    const fields = keys.slice(offset, offset + 16).flatMap((key) => [literal(key), `snapshot.${identifier(key)}`]).join(", ");
    parts.push(`json_object(${fields})`);
  }
  if (parts.length === 1) return parts[0]!;
  return `json('{' || ${parts.map((part) => `substr(${part}, 2, length(${part}) - 2)`).join(" || ',' || ")} || '}')`;
};

/** 読取結果を順序・件数も含めて保護する。検査用のJSON自体をD1の値上限に収める。 */
export const d1ReadResultGuards = (query: CompiledQuery, rows: readonly unknown[]): CompiledQuery[] => {
  if (!rows.length) return [CompiledQuery.raw(`SELECT 1 WHERE NOT EXISTS (${query.sql})`, [...query.parameters])];
  const guards: CompiledQuery[] = [];
  const window = (offset: number, count: number) => `SELECT * FROM (${query.sql}) LIMIT ${count} OFFSET ${offset}`;
  const addJsonGuard = (offset: number, values: unknown[], wholeResult: boolean) => guards.push(CompiledQuery.raw(
    `SELECT 1 WHERE (SELECT json_group_array(${rowObject(Object.keys(values[0] as object))}) FROM (${wholeResult ? query.sql : window(offset, values.length)}) AS snapshot) = ?`,
    [...query.parameters, JSON.stringify(values)],
  ));
  let start = 0, size = 2, group: unknown[] = [];
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index] as Record<string, unknown>;
    const bytes = encoder.encode(JSON.stringify(row)).byteLength + 1;
    if (group.length && size + bytes > maximumSnapshotBytes) {
      addJsonGuard(start, group, false); group = []; size = 2; start = index;
    }
    if (bytes <= maximumSnapshotBytes) { group.push(row); size += bytes; continue; }
    // 大きい文字列はJSON化で2MBを超える場合がある。生の値をbindし、型も照合する。
    // 元queryのbindとatomic guard IDの分を確保し、列数が多くても100 bindを超えない。
    const capacity = 99 - query.parameters.length;
    if (capacity < 1) throw new Error("D1 read snapshot has no parameter capacity for scalar verification");
    const entries = Object.entries(row);
    for (let offset = 0; offset < entries.length; offset += capacity) {
      const values: unknown[] = [];
      const conditions = entries.slice(offset, offset + capacity).map(([key, value]) => {
        const column = `snapshot.${identifier(key)}`;
        if (value === null) return `${column} IS NULL`;
        if (typeof value !== "string" && typeof value !== "number") throw new Error("Unsupported D1 snapshot scalar type");
        values.push(value);
        const type = typeof value === "string" ? "= 'text'" : "IN ('integer', 'real')";
        return `(${column} IS ? AND typeof(${column}) ${type})`;
      });
      guards.push(CompiledQuery.raw(`SELECT 1 WHERE EXISTS (SELECT 1 FROM (${window(index, 1)}) AS snapshot WHERE ${conditions.join(" AND ")})`, [...query.parameters, ...values]));
    }
    start = index + 1;
  }
  if (group.length) addJsonGuard(start, group, start === 0);
  // 部分ごとの検査では末尾の追加行を見落とすため、全体件数も同じbatchで照合する。
  if (guards.length > 1 || !group.length) guards.push(CompiledQuery.raw(`SELECT 1 WHERE (SELECT count(*) FROM (${query.sql})) = ${rows.length}`, [...query.parameters]));
  return guards;
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
    this.guards.push(...d1ReadResultGuards(query, result.rows));
    this.cache.set(key, structuredClone(result));
    return result;
  };
}
