import assert from "node:assert/strict";
import { CompiledQuery } from "kysely";
import type { D1Database } from "@cloudflare/workers-types";

/** workerdが再現しないD1のSQL関数引数数も、生成SQLで照合する。 */
const assertFunctionArguments = (statement: string) => {
  const tokens = statement.match(/'(?:''|[^'])*'|"(?:""|[^"])*"|[a-z_][a-z_0-9]*|[(),]/gi) ?? [];
  const stack: { name: string; arguments: number; empty: boolean }[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (token === "(") {
      if (stack.length) stack.at(-1)!.empty = false;
      stack.push({ name: tokens[index - 1] ?? "", arguments: 1, empty: true });
    } else if (token === ")") {
      const entry = stack.pop()!;
      if (entry.name === "json_object") assert.ok((entry.empty ? 0 : entry.arguments) <= 32, `D1 JSON function has ${entry.arguments} arguments`);
    } else if (stack.length) {
      if (token === ",") stack.at(-1)!.arguments++;
      else stack.at(-1)!.empty = false;
    }
  }
};

export const assertD1StatementLimits = (query: CompiledQuery) => {
  assert.ok(Buffer.byteLength(query.sql) <= 100_000, "SQL must fit D1");
  assert.ok(query.parameters.length <= 100, "binds must fit D1");
  for (const value of query.parameters) if (typeof value === "string") assert.ok(Buffer.byteLength(value) <= 2_000_000, "string binding must fit D1");
  assertFunctionArguments(query.sql);
};


/** SQL長・bind数・文字列値・json_object引数を検査する。CPU・行サイズ・invocation全体の上限は再現しない。 */
export const enforceD1StatementLimits = <T extends Pick<D1Database, "prepare">>(binding: T): T => new Proxy(binding, {
  get(target, property) {
    if (property === "prepare") return (statement: string) => {
      assertD1StatementLimits(CompiledQuery.raw(statement));
      const prepared = target.prepare(statement);
      return new Proxy(prepared, { get(object, method) {
        if (method === "bind") return (...parameters: unknown[]) => {
          assertD1StatementLimits(CompiledQuery.raw(statement, parameters));
          return object.bind(...parameters);
        };
        const value = Reflect.get(object, method); return typeof value === "function" ? value.bind(object) : value;
      } });
    };
    const value = Reflect.get(target, property);
    if (property === "withSession" && typeof value === "function") return (...args: unknown[]) => enforceD1StatementLimits(value.apply(target, args));
    return typeof value === "function" ? value.bind(target) : value;
  },
});
