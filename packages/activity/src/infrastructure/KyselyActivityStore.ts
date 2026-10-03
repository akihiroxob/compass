import { sql, type Kysely, type Selectable } from "kysely";
import type { Activity, ActivityReference, ActivityScope, ActivitySource } from "../domain/Activity.ts";
import type { ActivityQuery, ActivityStore, NewActivity } from "../application/port/ActivityStore.ts";
import type { ActivityDatabase, ActivityTable } from "./schema.ts";

type ActivityRow = Selectable<ActivityTable>;

const toActivity = (row: ActivityRow): Activity => ({
  id: row.id,
  cursor: Number(row.cursor),
  scope: row.scope as ActivityScope,
  projectId: row.project_id,
  type: row.type,
  principalId: row.principal_id,
  role: row.role,
  summary: row.summary,
  body: row.body,
  refs: JSON.parse(row.refs) as ActivityReference[],
  correctsActivityId: row.corrects_activity_id,
  source: row.source as ActivitySource,
  occurredAt: row.occurred_at,
  recordedAt: row.recorded_at,
});

/**
 * `ActivityStore`のKysely（SQLite）実装。transactionを受け取れば、その中で読み書きする（状態変更と同時に確定する）。
 * 一意制約（`dedupe_key`）の衝突は`on conflict do nothing`で吸収し、並行した再送でも1件に収束させる。
 */
export class KyselyActivityStore implements ActivityStore {
  constructor(private readonly db: Kysely<ActivityDatabase>) {}

  async append(activity: NewActivity) {
    const inserted = await this.db
      .insertInto("activity")
      .values({
        id: activity.id,
        scope: activity.scope,
        project_id: activity.projectId,
        type: activity.type,
        principal_id: activity.principalId,
        role: activity.role,
        summary: activity.summary,
        body: activity.body,
        refs: JSON.stringify(activity.refs),
        corrects_activity_id: activity.correctsActivityId,
        source: activity.source,
        dedupe_key: activity.dedupeKey,
        input_hash: activity.inputHash,
        occurred_at: activity.occurredAt,
        recorded_at: activity.recordedAt,
      })
      .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
      .returningAll()
      .executeTakeFirst();
    if (inserted) return { activity: toActivity(inserted), created: true, inputHash: inserted.input_hash };
    const existing = await this.db
      .selectFrom("activity")
      .selectAll()
      .where("dedupe_key", "=", activity.dedupeKey)
      .executeTakeFirstOrThrow();
    return { activity: toActivity(existing), created: false, inputHash: existing.input_hash };
  }

  async findByDedupeKey(dedupeKey: string) {
    const row = await this.db.selectFrom("activity").selectAll().where("dedupe_key", "=", dedupeKey).executeTakeFirst();
    return row ? { activity: toActivity(row), inputHash: row.input_hash } : null;
  }

  async find(activityId: string): Promise<Activity | null> {
    const row = await this.db.selectFrom("activity").selectAll().where("id", "=", activityId).executeTakeFirst();
    return row ? toActivity(row) : null;
  }

  async listProject(projectId: string, query: ActivityQuery): Promise<Activity[]> {
    let select = this.db
      .selectFrom("activity")
      .selectAll()
      .where("scope", "=", "project")
      .where("project_id", "=", projectId);
    if (query.principalId !== undefined) select = select.where("principal_id", "=", query.principalId);
    if (query.role !== undefined) select = select.where("role", "=", query.role);
    if (query.type !== undefined) select = select.where("type", "=", query.type);
    if (query.ref !== undefined) {
      const { kind, id } = query.ref;
      const key = kind === "project_resource" ? "$.resourceId" : "$.id";
      select = select.where(
        sql<boolean>`exists (select 1 from json_each(activity.refs) where json_extract(value, '$.kind') = ${kind} and json_extract(value, ${key}) = ${id})`,
      );
    }
    if (query.afterCursor !== undefined) {
      select = select.where("cursor", ">", query.afterCursor).orderBy("cursor", "asc");
    } else {
      if (query.beforeCursor !== undefined) select = select.where("cursor", "<", query.beforeCursor);
      select = select.orderBy("cursor", "desc");
    }
    const rows = await select.limit(query.limit).execute();
    return rows.map(toActivity);
  }

  async listCorrections(activityId: string): Promise<Activity[]> {
    const rows = await this.db
      .selectFrom("activity")
      .selectAll()
      .where("corrects_activity_id", "=", activityId)
      .orderBy("cursor", "asc")
      .execute();
    return rows.map(toActivity);
  }

  async maxProjectCursor(projectId: string): Promise<number> {
    const row = await this.db
      .selectFrom("activity")
      .select((builder) => builder.fn.max("cursor").as("cursor"))
      .where("project_id", "=", projectId)
      .executeTakeFirst();
    return Number(row?.cursor ?? 0);
  }
}
