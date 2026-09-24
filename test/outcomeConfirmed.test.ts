import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createApplicationServices } from "../src/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { ProjectRole } from "../src/constants/ProjectRole.ts";

/**
 * Outcome確定のRuntimeイベント（`outcome_confirmed`）と、既存`runtime_event`のtable再構築マイグレーション（Task 33）。
 * Runtime（Manager起動）は未接続で、ここでRuntimeとして振る舞うのはtest内のuse case呼び出しだけ。
 */

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database) };
};

const successCriteria = [{ description: "d", measurement: "m" }];
const outcomeInput = { title: "T", description: "D", rationale: "R", successCriteria };

const seedIntent = async ({ services }: Awaited<ReturnType<typeof setup>>) => {
  const project = await services.createProjectUseCase.execute({ name: "P", mission: "m" });
  const intent = await services.createIntentUseCase.execute(project.id, { title: "I", desiredState: "S" });
  return { project, intent };
};

const eventsOf = async ({ services }: Awaited<ReturnType<typeof setup>>, projectId: string) =>
  services.listRuntimeEventsUseCase.execute(projectId, { afterCursor: 0, limit: 500 });

test("create_outcomeとdecide_next_outcomeは、Outcomeと同一transactionでoutcome_confirmedを1件だけ保存する", async () => {
  const kit = await setup();
  const { project, intent } = await seedIntent(kit);

  const created = await kit.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const decided = await kit.services.decideNextOutcomeUseCase.execute(project.id, "strat", {
    intentId: intent.id,
    judgment: "J",
    reason: "R",
    requestKey: "decide-1",
    runRef: "run-1",
    outcome: outcomeInput,
  });
  // 同じrequestKeyの再送はOutcomeもイベントも増やさない。
  const replayed = await kit.services.decideNextOutcomeUseCase.execute(project.id, "strat", {
    intentId: intent.id,
    judgment: "J",
    reason: "R",
    requestKey: "decide-1",
    runRef: "run-1",
    outcome: outcomeInput,
  });
  assert.equal(replayed.outcome.id, decided.outcome.id);

  const confirmed = (await eventsOf(kit, project.id)).filter((event) => event.type === "outcome_confirmed");
  assert.deepEqual(
    confirmed.map((event) => event.outcomeId),
    [created.id, decided.outcome.id],
  );
  for (const event of confirmed) {
    assert.equal(event.projectId, project.id);
    assert.equal(event.intentId, intent.id);
    assert.equal(event.researchRequestId, null);
    assert.equal(event.conclusion, null);
    assert.equal(event.correlationId, `outcome:${event.outcomeId}`);
    assert.equal(event.version, 1);
  }
  // 既存のresearch_requestedイベントは変わらず、cursorは昇順。
  const all = await eventsOf(kit, project.id);
  assert.deepEqual(all.map((event) => event.type), ["research_requested", "outcome_confirmed", "outcome_confirmed"]);
  assert.deepEqual(all.map((event) => event.cursor), [...all.map((event) => event.cursor)].sort((a, b) => a - b));
  await kit.database.destroy();
});

test("Outcomeを作れない（Intentが非active）ときはイベントも作られず、イベントの保存に失敗するとOutcomeも残らない", async () => {
  const kit = await setup();
  const { project, intent } = await seedIntent(kit);
  const before = (await eventsOf(kit, project.id)).length;

  await kit.services.abandonIntentUseCase.execute(project.id, intent.id, {});
  await assert.rejects(() => kit.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput));
  assert.equal((await eventsOf(kit, project.id)).length, before);

  const second = await seedIntent(kit);
  // イベントの保存だけを失敗させると、Outcomeも保存されない（部分保存なし）。
  await sql`create trigger fail_outcome_event before insert on runtime_event when new.event_type = 'outcome_confirmed' begin select raise(abort, 'event store unavailable'); end`.execute(kit.database);
  await assert.rejects(() => kit.services.createOutcomeUseCase.execute(second.project.id, second.intent.id, outcomeInput), /event store unavailable/);
  await assert.rejects(
    () =>
      kit.services.decideNextOutcomeUseCase.execute(second.project.id, "strat", {
        intentId: second.intent.id,
        judgment: "J",
        reason: "R",
        requestKey: "k",
        runRef: "r",
        outcome: outcomeInput,
      }),
    /event store unavailable/,
  );
  assert.deepEqual(await kit.services.listOutcomesUseCase.execute(second.project.id, second.intent.id), []);
  assert.equal((await kit.database.selectFrom("direction_decision").select("id").execute()).length, 0);
  await sql`drop trigger fail_outcome_event`.execute(kit.database);

  // 復旧後は、同じ入力で作成できる。
  const recovered = await kit.services.createOutcomeUseCase.execute(second.project.id, second.intent.id, outcomeInput);
  const events = (await eventsOf(kit, second.project.id)).filter((event) => event.type === "outcome_confirmed");
  assert.deepEqual(events.map((event) => event.outcomeId), [recovered.id]);
  await kit.database.destroy();
});

test("Runtimeはoutcome_confirmedをconsumer単位でack・再取得でき、別Projectのイベントは取得できない", async () => {
  const kit = await setup();
  const { project, intent } = await seedIntent(kit);
  const other = await seedIntent(kit);
  for (const projectId of [project.id, other.project.id]) {
    await kit.services.grantProjectRoleUseCase.execute(projectId, { principalId: "rt", role: ProjectRole.RUNTIME });
  }
  const outcome = await kit.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  await kit.services.createOutcomeUseCase.execute(other.project.id, other.intent.id, outcomeInput);

  const fetched = await kit.services.fetchRuntimeEventsUseCase.execute("rt", project.id, {});
  const event = fetched.events.find((item) => item.type === "outcome_confirmed")!;
  assert.equal(event.outcomeId, outcome.id);
  assert.ok(fetched.events.every((item) => item.projectId === project.id));

  await kit.services.ackRuntimeEventUseCase.execute("rt", project.id, { eventId: event.id, outcome: "processed" });
  const after = await kit.services.fetchRuntimeEventsUseCase.execute("rt", project.id, {});
  assert.equal(after.events.some((item) => item.id === event.id), false);
  await kit.database.destroy();
});

/** Task 33より前のruntime_event（CHECKにoutcome_confirmedが無く、research_request_idがNOT NULL）を作る。 */
const downgradeRuntimeEvent = async (database: Awaited<ReturnType<typeof setup>>["database"]) => {
  await sql`pragma foreign_keys = off`.execute(database);
  await sql`
    create table runtime_event_legacy (
      sequence integer primary key autoincrement,
      id text not null unique,
      event_version integer not null,
      event_type text not null check (event_type in ('research_requested', 'research_completed')),
      project_id text not null references project (id) on delete cascade,
      intent_id text references intent (id) on delete cascade,
      research_request_id text not null references research_request (id) on delete cascade,
      correlation_id text not null,
      conclusion text check (conclusion is null or conclusion in ('completed', 'insufficient', 'not_needed')),
      created_at integer not null,
      constraint runtime_event_conclusion_matches_type check ((event_type = 'research_completed') = (conclusion is not null))
    )
  `.execute(database);
  await sql`
    insert into runtime_event_legacy (sequence, id, event_version, event_type, project_id, intent_id, research_request_id, correlation_id, conclusion, created_at)
    select sequence, id, event_version, event_type, project_id, intent_id, research_request_id, correlation_id, conclusion, created_at from runtime_event where event_type != 'outcome_confirmed'
  `.execute(database);
  await sql`drop table runtime_event`.execute(database);
  await sql`alter table runtime_event_legacy rename to runtime_event`.execute(database);
  await sql`pragma foreign_keys = on`.execute(database);
};

const runtimeEventSql = async (database: Awaited<ReturnType<typeof setup>>["database"]) =>
  (await sql<{ sql: string }>`select sql from sqlite_master where type = 'table' and name = 'runtime_event'`.execute(database)).rows[0]!.sql;

test("既存DBのruntime_eventは再初期化でtableを作り直し、event・sequence・ack・FKを保ったままoutcome_confirmedを受け付ける（再実行しても変わらない）", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-migration-"));
  const path = join(directory, "compass.db");
  try {
    const first = await setup(path);
    const { project, intent } = await seedIntent(first);
    const request = (await first.services.listResearchRequestsUseCase.execute(project.id, {}))[0]!;
    const [event] = await eventsOf(first, project.id);
    assert.ok(event);
    await first.services.grantProjectRoleUseCase.execute(project.id, { principalId: "rt", role: ProjectRole.RUNTIME });
    await first.services.ackRuntimeEventUseCase.execute("rt", project.id, { eventId: event.id, outcome: "retryable_failure", reason: "busy" });
    // autoincrementの高水位を最大sequenceより大きくする（削除済みの番号を再利用しない契約）。
    await downgradeRuntimeEvent(first.database);
    await sql`insert into runtime_event (sequence, id, event_version, event_type, project_id, intent_id, research_request_id, correlation_id, created_at) values (50, 'tmp', 1, 'research_requested', ${project.id}, ${intent.id}, ${request.id}, 'tmp', 1)`.execute(first.database);
    // 同じ(request, type)の重複は作れない。高水位だけを残すため、対象のrowを消す。
    await sql`delete from runtime_event where id = 'tmp'`.execute(first.database);
    assert.equal((await runtimeEventSql(first.database)).includes("outcome_confirmed"), false);
    await first.database.destroy();

    // 再起動（再初期化）でマイグレーションされる。
    const second = await setup(path);
    assert.equal((await runtimeEventSql(second.database)).includes("outcome_confirmed"), true);
    const migrated = await eventsOf(second, project.id);
    assert.deepEqual(migrated.map((item) => [item.id, item.cursor, item.type, item.researchRequestId, item.outcomeId]), [
      [event.id, event.cursor, "research_requested", request.id, null],
    ]);
    // ack済みの状態（consumerごとの結果・retry回数）が、FKを保ったまま引き継がれる。
    const pending = await second.services.fetchRuntimeEventsUseCase.execute("rt", project.id, {});
    assert.deepEqual(pending.events.map((item) => [item.id, item.retryCount, item.lastFailureReason]), [[event.id, 1, "busy"]]);
    assert.deepEqual((await sql`pragma foreign_key_check`.execute(second.database)).rows, []);
    assert.equal((await sql<{ foreign_keys: number }>`pragma foreign_keys`.execute(second.database)).rows[0]!.foreign_keys, 1);

    // 新しいイベントを受け付け、cursorは高水位より後ろで、既存の(request, type)の一意性も保たれる。
    const outcome = await second.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
    const after = await eventsOf(second, project.id);
    const confirmed = after.find((item) => item.type === "outcome_confirmed")!;
    assert.equal(confirmed.outcomeId, outcome.id);
    assert.ok(confirmed.cursor > 50, `cursor ${confirmed.cursor} は削除済みの番号を再利用しない`);
    await assert.rejects(
      () => sql`insert into runtime_event (id, event_version, event_type, project_id, intent_id, research_request_id, correlation_id, created_at) values ('dup', 1, 'research_requested', ${project.id}, ${intent.id}, ${request.id}, 'dup', 1)`.execute(second.database),
      /UNIQUE/,
    );
    // Outcomeイベントの発端が食い違う行はCHECKで拒否される。
    await assert.rejects(
      () => sql`insert into runtime_event (id, event_version, event_type, project_id, intent_id, research_request_id, correlation_id, created_at) values ('bad', 1, 'outcome_confirmed', ${project.id}, ${intent.id}, ${request.id}, 'bad', 1)`.execute(second.database),
      /CHECK/,
    );
    await second.database.destroy();

    // 再実行しても、event・cursorは変わらない。
    const third = await setup(path);
    assert.deepEqual((await eventsOf(third, project.id)).map((item) => [item.id, item.cursor]), after.map((item) => [item.id, item.cursor]));
    await third.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Execution tableは既存DBへ再初期化で追加され、Project・Intent・Outcomeを失わず、再実行しても変わらない", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-execution-schema-"));
  const path = join(directory, "compass.db");
  try {
    const first = await setup(path);
    const { project, intent } = await seedIntent(first);
    const outcome = await first.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
    // Task 33より前のDBには、Executionのtableが無い。
    for (const table of ["change_log", "command_receipt", "task_claim", "task_comment", "task", "story"]) {
      await sql`drop table ${sql.table(table)}`.execute(first.database);
    }
    await first.database.destroy();

    const second = await setup(path);
    const tables = (await sql<{ name: string }>`select name from sqlite_master where type = 'table' order by name`.execute(second.database)).rows.map((row) => row.name);
    for (const table of ["story", "task", "task_claim", "task_comment", "change_log", "command_receipt"]) assert.ok(tables.includes(table), table);
    assert.equal((await second.services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id)).id, outcome.id);
    assert.equal((await second.services.getProjectUseCase.execute(project.id)).id, project.id);
    await second.database.destroy();
    const third = await setup(path);
    assert.equal((await third.services.listOutcomesUseCase.execute(project.id, intent.id)).length, 1);
    await third.database.destroy();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
