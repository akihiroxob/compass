import { sql, type Kysely, type Selectable } from "kysely";
import type { Activity, ActivityReference, ActivityScope, ActivitySource } from "../domain/Activity.ts";
import type { ActivityQuery, ActivityStore, ActivityStreamQuery, NewActivity } from "../application/port/ActivityStore.ts";
import type { ActivityDatabase, ActivityTable } from "./schema.ts";

type ActivityRow = Selectable<ActivityTable>;

const toActivity = (row: ActivityRow): Activity => ({
  id: row.id,
  cursor: Number(row.cursor),
  scope: row.scope as ActivityScope,
  workspaceId: row.workspace_id,
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

/** SQLiteとD1で共有する保存値。 */
export const activityValues = (activity: NewActivity) => ({
      id: activity.id,
      scope: activity.scope,
      workspace_id: activity.workspaceId,
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
    });

/** 同じ列・dedupe規則で、即時実行または外側のbatchへの組込みに使う。 */
export const insertActivityQuery = (database: Kysely<ActivityDatabase>, activity: NewActivity) =>
  database
    .insertInto("activity")
    .values(activityValues(activity))
    .onConflict((conflict) => conflict.column("dedupe_key").doNothing())
    .returningAll();

/**
 * `ActivityStore`のKysely（SQLite）実装。transactionを受け取れば、その中で読み書きする（状態変更と同時に確定する）。
 * 一意制約（`dedupe_key`）の衝突は`on conflict do nothing`で吸収し、並行した再送でも1件に収束させる。
 */
export class KyselyActivityStore implements ActivityStore {
  constructor(private readonly db: Kysely<ActivityDatabase>) {}

  async append(activity: NewActivity) {
    const inserted = await insertActivityQuery(this.db, activity).executeTakeFirst();
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

  listProject(projectId: string, query: ActivityQuery): Promise<Activity[]> {
    return this.listScope("project", "project_id", projectId, query);
  }

  listWorkspace(workspaceId: string, query: ActivityQuery): Promise<Activity[]> {
    return this.listScope("workspace", "workspace_id", workspaceId, query);
  }

  private async listScope(scope: ActivityScope, column: "project_id" | "workspace_id", id: string, query: ActivityQuery): Promise<Activity[]> {
    let select = this.db
      .selectFrom("activity")
      .selectAll()
      .where("scope", "=", scope)
      .where(column, "=", id);
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

  async listWorkspaceStream(workspaceId: string, query: ActivityStreamQuery) {
    // 別Workspaceとsystem（workspace_idなし）を除くため、必ずworkspace_idで絞る。Project Activityも同じ列で所属Workspaceを持つ。
    let filtered = this.db
      .selectFrom("activity")
      .where("workspace_id", "=", workspaceId)
      .where("scope", "in", ["workspace", "project"]);
    if (query.projectId !== undefined) filtered = filtered.where("project_id", "=", query.projectId);
    if (query.workspaceOnly) filtered = filtered.where("scope", "=", "workspace");
    if (query.occurredFrom !== undefined) filtered = filtered.where("occurred_at", ">=", query.occurredFrom);
    if (query.occurredTo !== undefined) filtered = filtered.where("occurred_at", "<=", query.occurredTo);
    if (query.text !== undefined) {
      // D1のLIKE patternは50 bytesまで。literalの部分一致はinstrで同じ意味を保つ。
      filtered = filtered.where(
        sql<boolean>`(instr(lower(summary), lower(${query.text})) > 0 or instr(lower(coalesce(body, '')), lower(${query.text})) > 0
          or instr(lower(type), lower(${query.text})) > 0 or instr(lower(principal_id), lower(${query.text})) > 0)`,
      );
    }
    // 種別の候補は、種別以外の条件に一致する記録の種別（現在のページに限らない）。
    const typeRows = await filtered.select("type").distinct().orderBy("type", "asc").execute();
    if (query.type !== undefined) filtered = filtered.where("type", "=", query.type);
    const counted = await filtered.select((builder) => builder.fn.countAll().as("count")).executeTakeFirst();
    let select = filtered.selectAll();
    if (query.after !== undefined) {
      const { occurredAt, cursor } = query.after;
      select = select
        .where(sql<boolean>`(occurred_at > ${occurredAt} or (occurred_at = ${occurredAt} and cursor > ${cursor}))`)
        .orderBy("occurred_at", "asc")
        .orderBy("cursor", "asc");
    } else {
      if (query.before !== undefined) {
        const { occurredAt, cursor } = query.before;
        select = select.where(sql<boolean>`(occurred_at < ${occurredAt} or (occurred_at = ${occurredAt} and cursor < ${cursor}))`);
      }
      select = select.orderBy("occurred_at", "desc").orderBy("cursor", "desc");
    }
    const rows = await select.limit(query.limit).execute();
    return { activities: rows.map(toActivity), matchedCount: Number(counted?.count ?? 0), types: typeRows.map(({ type }) => type) };
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

  maxProjectCursor(projectId: string): Promise<number> {
    return this.maxScopeCursor("project", "project_id", projectId);
  }

  maxWorkspaceCursor(workspaceId: string): Promise<number> {
    return this.maxScopeCursor("workspace", "workspace_id", workspaceId);
  }

  private async maxScopeCursor(scope: ActivityScope, column: "project_id" | "workspace_id", id: string): Promise<number> {
    const row = await this.db
      .selectFrom("activity")
      .select((builder) => builder.fn.max("cursor").as("cursor"))
      .where("scope", "=", scope)
      .where(column, "=", id)
      .executeTakeFirst();
    return Number(row?.cursor ?? 0);
  }
}
