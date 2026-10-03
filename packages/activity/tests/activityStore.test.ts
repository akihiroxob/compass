import assert from "node:assert/strict";
import test from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import { recordCanonicalWorkActivity, type WorkChangeFact } from "../src/application/canonicalWorkActivity.ts";
import type { NewActivity } from "../src/application/port/ActivityStore.ts";
import { initializeActivitySchema } from "../src/infrastructure/initializeActivitySchema.ts";
import { KyselyActivityStore } from "../src/infrastructure/KyselyActivityStore.ts";
import type { ActivityDatabase } from "../src/infrastructure/schema.ts";

/**
 * Activity package単体の保存規則（scopeとprojectIdの整合・必須summary・dedupe keyによる収束・cursor）と、
 * Workの状態変更からのcanonical生成の対象・内容。`project`は外部キーの参照先として、IDだけのtableをfixtureで用意する。
 * 認可・Projectの状態・Workとの同一transactionはserverのテスト（activity.test.ts）で検証する。
 */
const openStore = async () => {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const database = new Kysely<ActivityDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  await sql`create table project (id text primary key)`.execute(database);
  await sql`insert into project (id) values ('p1')`.execute(database);
  await initializeActivitySchema(database);
  await initializeActivitySchema(database);
  return { database, store: new KyselyActivityStore(database) };
};

let sequence = 0;
const activity = (overrides: Partial<NewActivity> = {}): NewActivity => {
  sequence += 1;
  return {
    id: `a-${sequence}`,
    scope: "project",
    projectId: "p1",
    type: "note",
    principalId: "worker-a",
    role: "worker",
    summary: "summary",
    body: null,
    refs: [],
    correctsActivityId: null,
    source: "recorded",
    occurredAt: 1_000,
    recordedAt: 1_000,
    dedupeKey: `key-${sequence}`,
    inputHash: null,
    ...overrides,
  };
};

test("scopeとprojectIdの整合・空のsummaryはDBでも拒否する", async () => {
  const { database, store } = await openStore();
  await assert.rejects(store.append(activity({ projectId: null })));
  await assert.rejects(store.append(activity({ scope: "system" })));
  await assert.rejects(store.append(activity({ summary: "  " })));
  const system = await store.append(activity({ scope: "system", projectId: null }));
  assert.equal(system.activity.projectId, null);
  // system scopeはProjectの一覧に出ない。
  assert.deepEqual(await store.listProject("p1", { limit: 10 }), []);
  await database.destroy();
});

test("同じdedupe keyは追記せず保存済みを返し、cursorは単調増加する", async () => {
  const { database, store } = await openStore();
  const first = await store.append(activity({ dedupeKey: "same", inputHash: "h1" }));
  const again = await store.append(activity({ dedupeKey: "same", inputHash: "h2", summary: "other" }));
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(again.activity.id, first.activity.id);
  assert.equal(again.inputHash, "h1");
  const second = await store.append(activity());
  assert.ok(second.activity.cursor > first.activity.cursor);
  assert.equal(await store.maxProjectCursor("p1"), second.activity.cursor);
  await database.destroy();
});

const fact = (overrides: Partial<WorkChangeFact> = {}): WorkChangeFact => ({
  cursor: 1,
  projectId: "p1",
  type: "TASK_REJECTED",
  principalId: "reviewer-a",
  payload: { actorRole: "reviewer", reason: "テストが不足" },
  occurredAt: 2_000,
  subject: { kind: "task", id: "t1", title: "保存する", storyId: "s1" },
  ...overrides,
});

test("canonical Activityは対象のChangeだけを、Changeのcursorごとに1件だけ作る", async () => {
  const { database, store } = await openStore();
  await recordCanonicalWorkActivity(store, fact());
  await recordCanonicalWorkActivity(store, fact());
  await recordCanonicalWorkActivity(store, fact({ cursor: 2, type: "TASK_CLAIMED" }));
  await recordCanonicalWorkActivity(store, fact({ cursor: 3, type: "TASK_EDITED" }));
  const [rejected, ...rest] = await store.listProject("p1", { limit: 10 });
  assert.deepEqual(rest, []);
  assert.equal(rejected!.type, "task.rejected");
  assert.equal(rejected!.role, "reviewer");
  assert.equal(rejected!.principalId, "reviewer-a");
  assert.equal(rejected!.summary, "Task「保存する」を差し戻した");
  assert.equal(rejected!.body, "理由: テストが不足");
  assert.equal(rejected!.source, "canonical");
  assert.deepEqual(rejected!.refs, [{ kind: "task", id: "t1" }, { kind: "story", id: "s1" }]);
  await database.destroy();
});
