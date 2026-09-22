import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { createApplicationServices } from "../src/container.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";

const projectInput = { name: "Compass", mission: "Keep direction explicit" };
const intentInput = { title: "Agents improve software", desiredState: "Agents improve the software." };
const outcomeInput = {
  title: "No duplicate claims",
  description: "Claims are exclusive.",
  hypothesis: "Exclusive claims make parallel work safe.",
  rationale: "Duplicate claims are the main source of rework.",
  successCriteria: [
    { description: "duplicate_claim_count = 0", measurement: "Count duplicate claims in the change log", target: "= 0" },
    { description: "All claims are audited", measurement: "Every claim has a change log entry" },
  ],
};

const setup = async (path = ":memory:") => {
  const database = createDatabase(path);
  await initializeSchema(database);
  return { database, services: createApplicationServices(database) };
};

const seed = async (services: Awaited<ReturnType<typeof setup>>["services"]) => {
  const project = await services.createProjectUseCase.execute(projectInput);
  const intent = await services.createIntentUseCase.execute(project.id, intentInput);
  return { project, intent };
};

type Rejection = { code?: string; details?: Record<string, string>; message?: string; issues?: { path: string }[] };
const rejectsWith = (code: string, check: (error: Rejection) => void = () => {}) => (error: unknown) => {
  assert.equal((error as Rejection).code, code);
  check(error as Rejection);
  return true;
};

test("Outcomeはactiveで保存され、成功条件は入力順で、再起動後も同じIDと内容で取得できる", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-outcome-"));
  const path = join(directory, "test.db");
  const first = await setup(path);
  const { project, intent } = await seed(first.services);
  const created = await first.services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  assert.equal(created.status, "active");
  assert.equal(created.projectId, project.id);
  assert.equal(created.intentId, intent.id);
  assert.equal(created.cancelReason, null);
  assert.deepEqual(
    created.successCriteria.map(({ position, description, target }) => [position, description, target]),
    [
      [0, "duplicate_claim_count = 0", "= 0"],
      [1, "All claims are audited", null],
    ],
  );
  assert.ok(created.successCriteria.every((item) => item.outcomeId === created.id && item.id.length > 0));
  await first.database.destroy();

  const second = await setup(path);
  assert.deepEqual(await second.services.getOutcomeUseCase.execute(project.id, intent.id, created.id), created);
  assert.deepEqual(await second.services.listOutcomesUseCase.execute(project.id, intent.id), [created]);
  await second.database.destroy();
  await rm(directory, { recursive: true, force: true });
});

test("initializeSchemaは既存DBに対して再実行してもOutcomeを壊さない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const created = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  await initializeSchema(database);
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.id, intent.id, created.id), created);
  await database.destroy();
});

test("入力はtrimされ、hypothesis・targetの省略と空文字はnullになる。Researchなしで作成できる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const created = await services.createOutcomeUseCase.execute(project.id, intent.id, {
    title: "  Title  ",
    description: " D ",
    hypothesis: "   ",
    rationale: " R ",
    successCriteria: [{ description: " c ", measurement: " m ", target: " " }],
  });
  assert.equal(created.title, "Title");
  assert.equal(created.description, "D");
  assert.equal(created.rationale, "R");
  assert.equal(created.hypothesis, null);
  assert.deepEqual(
    created.successCriteria.map(({ description, measurement, target }) => ({ description, measurement, target })),
    [{ description: "c", measurement: "m", target: null }],
  );
  await database.destroy();
});

test("不正な入力はVALIDATION_ERRORで拒否し、OutcomeもCriterionも保存しない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const criterion = { description: "d", measurement: "m" };
  const criteria = (count: number) => Array.from({ length: count }, () => criterion);

  const invalidInputs: [unknown, string][] = [
    [{ ...outcomeInput, title: " " }, "title"],
    [{ ...outcomeInput, title: "x".repeat(101) }, "title"],
    [{ ...outcomeInput, description: " " }, "description"],
    [{ ...outcomeInput, description: "x".repeat(2_001) }, "description"],
    [{ ...outcomeInput, rationale: "" }, "rationale"],
    [{ ...outcomeInput, hypothesis: "x".repeat(2_001) }, "hypothesis"],
    [{ ...outcomeInput, successCriteria: [] }, "successCriteria"],
    [{ ...outcomeInput, successCriteria: criteria(11) }, "successCriteria"],
    [{ ...outcomeInput, successCriteria: undefined }, "successCriteria"],
    [{ ...outcomeInput, successCriteria: [criterion, { description: "d", measurement: "   " }] }, "successCriteria.1.measurement"],
    [{ ...outcomeInput, successCriteria: [{ description: "", measurement: "m" }] }, "successCriteria.0.description"],
    [{ ...outcomeInput, successCriteria: [{ description: "x".repeat(501), measurement: "m" }] }, "successCriteria.0.description"],
    [{ ...outcomeInput, successCriteria: [{ description: "d", measurement: "x".repeat(1_001) }] }, "successCriteria.0.measurement"],
    [{ ...outcomeInput, successCriteria: [{ ...criterion, target: "x".repeat(201) }] }, "successCriteria.0.target"],
    [null, ""],
    [[], ""],
  ];
  for (const [input, path] of invalidInputs) {
    await assert.rejects(
      services.createOutcomeUseCase.execute(project.id, intent.id, input),
      rejectsWith("VALIDATION_ERROR", (error) => assert.equal(error.issues?.[0]?.path, path, JSON.stringify(input))),
    );
  }
  assert.deepEqual(await services.listOutcomesUseCase.execute(project.id, intent.id), []);
  const criterionCount = await sql<{ count: number }>`select count(*) as count from success_criterion`.execute(database);
  assert.equal(criterionCount.rows[0]?.count, 0);

  const boundary = await services.createOutcomeUseCase.execute(project.id, intent.id, {
    ...outcomeInput,
    title: "x".repeat(100),
    successCriteria: criteria(10),
  });
  assert.equal(boundary.successCriteria.length, 10);
  await database.destroy();
});

test("DBの制約が、application層を経由しない重複positionと不正なstatusも拒否する", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  await assert.rejects(
    sql`insert into success_criterion (id, outcome_id, position, description, measurement, created_at)
      values (${crypto.randomUUID()}, ${outcome.id}, 0, 'd', 'm', 1)`.execute(database),
    /UNIQUE/,
  );
  const insert = (status: string) =>
    sql`insert into outcome (id, project_id, intent_id, title, description, rationale, status, created_at, updated_at)
      values (${crypto.randomUUID()}, ${project.id}, ${intent.id}, 't', 'd', 'r', ${status}, 1, 1)`.execute(database);
  await assert.rejects(insert("proposed"), /CHECK/);
  // 予約済みの状態値は、DB変更なしで後続が使える。
  await insert("achieved");
  await database.destroy();
});

test("Intent配下のactive Outcomeは複数並び、一覧は新しい順になる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const a = await services.createOutcomeUseCase.execute(project.id, intent.id, { ...outcomeInput, title: "A" });
  const b = await services.createOutcomeUseCase.execute(project.id, intent.id, { ...outcomeInput, title: "B" });
  const c = await services.createOutcomeUseCase.execute(project.id, intent.id, { ...outcomeInput, title: "C" });
  assert.ok([a, b, c].every((outcome) => outcome.status === "active"));
  assert.deepEqual(
    (await services.listOutcomesUseCase.execute(project.id, intent.id)).map((outcome) => outcome.title),
    ["C", "B", "A"],
  );
  await database.destroy();
});

test("固定項目を含む更新はCONFLICTで拒否し、Outcomeと成功条件は変わらない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const created = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);

  const attempts: [Record<string, unknown>, string][] = [
    [{ successCriteria: [{ description: "x", measurement: "y" }] }, "successCriteria"],
    [{ successCriteria: [] }, "successCriteria"],
    [{ description: "Changed" }, "description"],
    [{ rationale: "Changed" }, "rationale"],
    [{ title: "Renamed", description: "Changed", rationale: "Changed" }, "description,rationale"],
  ];
  for (const [input, fixedFields] of attempts) {
    await assert.rejects(
      services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, input),
      rejectsWith("CONFLICT", (error) => assert.equal(error.details?.fixedFields, fixedFields)),
      JSON.stringify(input),
    );
  }
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.id, intent.id, created.id), created);
  await database.destroy();
});

test("titleとhypothesisだけを更新でき、hypothesisは空文字またはnullでクリアできる", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const created = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);

  const renamed = await services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { title: " New " });
  assert.equal(renamed.title, "New");
  assert.equal(renamed.hypothesis, created.hypothesis);
  assert.ok(renamed.updatedAt >= created.updatedAt);
  assert.deepEqual(renamed.successCriteria, created.successCriteria);
  assert.equal(renamed.description, created.description);
  assert.equal(renamed.rationale, created.rationale);

  const cleared = await services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { hypothesis: "" });
  assert.equal(cleared.hypothesis, null);
  assert.equal(cleared.title, "New");
  const set = await services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { hypothesis: " H " });
  assert.equal(set.hypothesis, "H");
  const nulled = await services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { hypothesis: null });
  assert.equal(nulled.hypothesis, null);

  for (const input of [{}, { title: " " }, { title: "x".repeat(101) }, { hypothesis: "x".repeat(2_001) }, null]) {
    await assert.rejects(
      services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, input),
      rejectsWith("VALIDATION_ERROR"),
      JSON.stringify(input),
    );
  }
  // statusなどの未知の項目は無視され、状態は変わらない。
  const ignored = await services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { title: "t", status: "achieved" });
  assert.equal(ignored.status, "active");
  await database.destroy();
});

test("取消は理由が必須で、cancelled後は更新・再取消できず、成功条件は保持される", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const created = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);

  for (const input of [undefined, {}, { reason: "  " }, { reason: "x".repeat(2_001) }, null]) {
    await assert.rejects(
      services.cancelOutcomeUseCase.execute(project.id, intent.id, created.id, input),
      rejectsWith("VALIDATION_ERROR"),
      JSON.stringify(input),
    );
  }
  assert.equal((await services.getOutcomeUseCase.execute(project.id, intent.id, created.id)).status, "active");

  const cancelled = await services.cancelOutcomeUseCase.execute(project.id, intent.id, created.id, { reason: " Wrong metric " });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancelReason, "Wrong metric");
  assert.deepEqual(cancelled.successCriteria, created.successCriteria);

  await assert.rejects(
    services.updateOutcomeUseCase.execute(project.id, intent.id, created.id, { title: "Edit" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.status, "cancelled")),
  );
  await assert.rejects(
    services.cancelOutcomeUseCase.execute(project.id, intent.id, created.id, { reason: "again" }),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.status, "cancelled")),
  );
  assert.deepEqual(await services.getOutcomeUseCase.execute(project.id, intent.id, created.id), cancelled);
  await database.destroy();
});

test("他ProjectやIntent配下のIDはNOT_FOUNDで、内容を露出せず変更もしない。存在しないIDは区別できる", async () => {
  const { database, services } = await setup();
  const projectA = await services.createProjectUseCase.execute(projectInput);
  const intentOld = await services.createIntentUseCase.execute(projectA.id, intentInput);
  await services.abandonIntentUseCase.execute(projectA.id, intentOld.id);
  const intentA = await services.createIntentUseCase.execute(projectA.id, intentInput);
  const projectB = await services.createProjectUseCase.execute({ ...projectInput, name: "B" });
  const intentB = await services.createIntentUseCase.execute(projectB.id, intentInput);
  const outcomeA = await services.createOutcomeUseCase.execute(projectA.id, intentA.id, outcomeInput);

  const messageOf = async (operation: Promise<unknown>) => {
    try {
      await operation;
    } catch (error) {
      assert.equal((error as Rejection).code, "NOT_FOUND");
      return (error as Error).message;
    }
    return assert.fail("should reject");
  };

  // 他ProjectのIDでも、同じProject内の別IntentのIDでも参照・更新・取消できない。
  for (const [projectId, intentId] of [
    [projectB.id, intentA.id],
    [projectB.id, intentB.id],
    [projectA.id, intentOld.id],
  ] as const) {
    assert.match(await messageOf(services.getOutcomeUseCase.execute(projectId, intentId, outcomeA.id)), /^(Intent|Outcome) /);
    assert.match(
      await messageOf(services.updateOutcomeUseCase.execute(projectId, intentId, outcomeA.id, { title: "Hijacked" })),
      /^(Intent|Outcome) /,
    );
    assert.match(
      await messageOf(services.cancelOutcomeUseCase.execute(projectId, intentId, outcomeA.id, { reason: "x" })),
      /^(Intent|Outcome) /,
    );
  }
  assert.deepEqual(await services.listOutcomesUseCase.execute(projectB.id, intentB.id), []);
  assert.deepEqual(await services.listOutcomesUseCase.execute(projectA.id, intentOld.id), []);

  assert.match(await messageOf(services.getOutcomeUseCase.execute("missing", "x", "y")), /^Project missing/);
  assert.match(await messageOf(services.listOutcomesUseCase.execute("missing", "x")), /^Project missing/);
  assert.match(await messageOf(services.createOutcomeUseCase.execute("missing", "x", outcomeInput)), /^Project missing/);
  assert.match(await messageOf(services.updateOutcomeUseCase.execute("missing", "x", "y", { title: "t" })), /^Project missing/);
  assert.match(await messageOf(services.cancelOutcomeUseCase.execute("missing", "x", "y", { reason: "r" })), /^Project missing/);
  assert.match(await messageOf(services.getOutcomeUseCase.execute(projectB.id, "nope", "y")), /^Intent nope/);
  assert.match(await messageOf(services.listOutcomesUseCase.execute(projectB.id, "nope")), /^Intent nope/);
  assert.match(await messageOf(services.createOutcomeUseCase.execute(projectB.id, "nope", outcomeInput)), /^Intent nope/);
  assert.match(await messageOf(services.updateOutcomeUseCase.execute(projectB.id, "nope", "y", { title: "t" })), /^Intent nope/);
  assert.match(await messageOf(services.cancelOutcomeUseCase.execute(projectB.id, "nope", "y", { reason: "r" })), /^Intent nope/);
  assert.match(await messageOf(services.getOutcomeUseCase.execute(projectB.id, intentB.id, "nope")), /^Outcome nope/);
  assert.match(await messageOf(services.updateOutcomeUseCase.execute(projectB.id, intentB.id, "nope", { title: "t" })), /^Outcome nope/);
  assert.match(await messageOf(services.cancelOutcomeUseCase.execute(projectB.id, intentB.id, "nope", { reason: "r" })), /^Outcome nope/);

  assert.deepEqual(await services.getOutcomeUseCase.execute(projectA.id, intentA.id, outcomeA.id), outcomeA);
  await database.destroy();
});

test("activeでないIntentへのOutcome作成はstatus付きのCONFLICTで、何も保存しない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  await services.abandonIntentUseCase.execute(project.id, intent.id);
  await assert.rejects(
    services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput),
    rejectsWith("CONFLICT", (error) => assert.equal(error.details?.status, "abandoned")),
  );
  assert.deepEqual(await services.listOutcomesUseCase.execute(project.id, intent.id), []);
  await database.destroy();
});

test("Intentの放棄は、同一transactionでactiveなOutcomeだけをcancelledにする", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const keep = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const cancelledEarlier = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  await services.cancelOutcomeUseCase.execute(project.id, intent.id, cancelledEarlier.id, { reason: "Earlier" });
  const other = await services.createProjectUseCase.execute({ ...projectInput, name: "Other" });
  const otherIntent = await services.createIntentUseCase.execute(other.id, intentInput);
  const otherOutcome = await services.createOutcomeUseCase.execute(other.id, otherIntent.id, outcomeInput);

  const abandoned = await services.abandonIntentUseCase.execute(project.id, intent.id, { reason: " Wrong goal " });
  assert.equal(abandoned.status, "abandoned");
  const outcomes = await services.listOutcomesUseCase.execute(project.id, intent.id);
  const byId = new Map(outcomes.map((outcome) => [outcome.id, outcome]));
  assert.equal(byId.get(keep.id)?.status, "cancelled");
  assert.equal(byId.get(keep.id)?.cancelReason, "Intent abandoned: Wrong goal");
  assert.deepEqual(byId.get(keep.id)?.successCriteria, keep.successCriteria);
  assert.equal(byId.get(cancelledEarlier.id)?.cancelReason, "Earlier");
  // 他Intentには影響しない。
  assert.equal((await services.getOutcomeUseCase.execute(other.id, otherIntent.id, otherOutcome.id)).status, "active");

  // 理由なしの放棄は固定文言だけを残す。
  const next = await services.createIntentUseCase.execute(project.id, intentInput);
  const nextOutcome = await services.createOutcomeUseCase.execute(project.id, next.id, outcomeInput);
  await services.abandonIntentUseCase.execute(project.id, next.id);
  assert.equal((await services.getOutcomeUseCase.execute(project.id, next.id, nextOutcome.id)).cancelReason, "Intent abandoned");
  await database.destroy();
});

test("Outcomeの取消更新が失敗するとIntentの放棄も取り消される（片方だけ更新された状態を残さない）", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  // Outcomeの更新だけを失敗させるtriggerを置き、Intentの更新がrollbackされることを確認する。
  await sql`create trigger fail_outcome_update before update on outcome begin select raise(abort, 'boom'); end`.execute(database);
  await assert.rejects(services.abandonIntentUseCase.execute(project.id, intent.id, { reason: "x" }));
  await sql`drop trigger fail_outcome_update`.execute(database);
  assert.equal((await services.getIntentUseCase.execute(project.id, intent.id)).status, "active");
  assert.equal((await services.getOutcomeUseCase.execute(project.id, intent.id, outcome.id)).status, "active");
  await database.destroy();
});

test("Outcomeを持つIntentは意味を変更できず、titleと同じ値の再送は許される。持たないIntentは従来どおり", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);

  const free = await services.updateIntentUseCase.execute(project.id, intent.id, {
    desiredState: "Edited before any Outcome",
    completionDefinition: "Done",
  });
  assert.equal(free.desiredState, "Edited before any Outcome");

  const outcome = await services.createOutcomeUseCase.execute(project.id, intent.id, outcomeInput);
  const locked = (fixedFields: string) => rejectsWith("CONFLICT", (error) => assert.equal(error.details?.fixedFields, fixedFields));
  await assert.rejects(services.updateIntentUseCase.execute(project.id, intent.id, { desiredState: "Changed" }), locked("desiredState"));
  await assert.rejects(services.updateIntentUseCase.execute(project.id, intent.id, { completionDefinition: "Other" }), locked("completionDefinition"));
  await assert.rejects(services.updateIntentUseCase.execute(project.id, intent.id, { completionDefinition: null }), locked("completionDefinition"));
  await assert.rejects(
    services.updateIntentUseCase.execute(project.id, intent.id, { title: "Renamed", desiredState: "Changed", completionDefinition: "" }),
    locked("desiredState,completionDefinition"),
  );
  assert.deepEqual(await services.getIntentUseCase.execute(project.id, intent.id), free);

  // titleは変更できる。編集フォームが3項目すべてを送っても、意味が同じなら通る。
  const renamed = await services.updateIntentUseCase.execute(project.id, intent.id, {
    title: "Renamed",
    desiredState: free.desiredState,
    completionDefinition: free.completionDefinition,
  });
  assert.equal(renamed.title, "Renamed");

  // Outcomeが取り消されても、Outcomeが存在する限りIntentの意味は固定のまま。
  await services.cancelOutcomeUseCase.execute(project.id, intent.id, outcome.id, { reason: "x" });
  await assert.rejects(services.updateIntentUseCase.execute(project.id, intent.id, { desiredState: "Changed" }), locked("desiredState"));
  await database.destroy();
});

test("Intentを作成してもOutcomeは自動生成されず、Outcomeの状態を書き換える公開操作もない", async () => {
  const { database, services } = await setup();
  const { project, intent } = await seed(services);
  assert.deepEqual(await services.listOutcomesUseCase.execute(project.id, intent.id), []);
  assert.deepEqual(Object.keys(services).filter((name) => name.includes("Outcome")).sort(), [
    "cancelOutcomeUseCase",
    "createOutcomeUseCase",
    "decideNextOutcomeUseCase",
    "getOutcomeUseCase",
    "listOutcomesUseCase",
    "updateOutcomeUseCase",
  ]);
  await database.destroy();
});
