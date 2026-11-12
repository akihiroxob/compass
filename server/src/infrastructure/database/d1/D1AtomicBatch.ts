import type { CompiledQuery } from "kysely";
import type { D1Database, D1Result } from "@cloudflare/workers-types";

export class D1PreconditionFailedError extends Error {
  constructor(options?: ErrorOptions) {
    super("D1 atomic operation precondition no longer holds", options);
    this.name = "D1PreconditionFailedError";
  }
}

/**
 * 読取後に決めた更新を、SQLの前提条件の再検査と同じbatchで確定する。
 * 更新0件を成功扱いのまま通さず、前提不成立はCHECK制約でbatch全体を巻き戻す。
 * 前提の選定・再読取・再判定は各Repository/Applicationの責務。
 */
export class D1AtomicBatch {
  constructor(private readonly binding: D1Database) {}

  async execute(preconditions: readonly CompiledQuery[], mutations: readonly CompiledQuery[]): Promise<D1Result[]> {
    if (mutations.length === 0) throw new Error("D1 atomic batch requires at least one mutation");
    const ids = preconditions.map(() => crypto.randomUUID());
    const guards = preconditions.map((query, index) => this.binding.prepare(
      `INSERT INTO compass_d1_guard (id, satisfied) SELECT ?, CASE WHEN EXISTS (${query.sql}) THEN 1 ELSE 0 END`,
    ).bind(ids[index], ...query.parameters));
    const statements = mutations.map((query) => this.binding.prepare(query.sql).bind(...query.parameters));
    // D1は1 statementにつき100 bind parametersまで。検査が多いbatchも一括commitのまま掃除する。
    for (let offset = 0; offset < ids.length; offset += 100) {
      const chunk = ids.slice(offset, offset + 100);
      statements.push(this.binding.prepare(
        `DELETE FROM compass_d1_guard WHERE id IN (${chunk.map(() => "?").join(", ")})`,
      ).bind(...chunk));
    }
    try {
      const results = await this.binding.batch([...guards, ...statements]);
      return results.slice(guards.length, guards.length + mutations.length);
    } catch (error) {
      // ネットワーク障害等を前提不成立や安全な再試行にすり替えない。
      if (error instanceof Error && error.message.includes("CHECK constraint failed: compass_d1_precondition")) {
        throw new D1PreconditionFailedError({ cause: error });
      }
      throw error;
    }
  }
}
