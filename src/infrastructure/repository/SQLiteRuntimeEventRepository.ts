import type { Kysely, Selectable } from "kysely";
import type { RuntimeEvent } from "../../domain/model/RuntimeEvent.ts";
import type { RuntimeEventRepository } from "../../domain/repository/RuntimeEventRepository.ts";
import type { Database, RuntimeEventTable } from "../database/schema.ts";

const toRuntimeEvent = (row: Selectable<RuntimeEventTable>): RuntimeEvent => ({
  cursor: row.sequence,
  id: row.id,
  version: row.event_version,
  type: row.event_type,
  projectId: row.project_id,
  intentId: row.intent_id,
  researchRequestId: row.research_request_id,
  correlationId: row.correlation_id,
  conclusion: row.conclusion,
  occurredAt: row.created_at,
});

export class SQLiteRuntimeEventRepository implements RuntimeEventRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async findAfter(projectId: string, afterCursor: number, limit: number): Promise<RuntimeEvent[]> {
    const rows = await this.database
      .selectFrom("runtime_event")
      .selectAll()
      .where("project_id", "=", projectId)
      .where("sequence", ">", afterCursor)
      .orderBy("sequence", "asc")
      .limit(limit)
      .execute();
    return rows.map(toRuntimeEvent);
  }
}
