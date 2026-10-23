import assert from "node:assert/strict";
import test from "node:test";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, sql, SqliteDialect } from "kysely";
import {
  checkAgentResponse,
  checkHumanClosing,
  checkHumanMessage,
  checkLeaseAcquisition,
  checkSupersedes,
  hasHumanBasis,
  isLeaseActive,
  statusAfterMessage,
  type ConsultationLease,
} from "../src/domain/Consultation.ts";
import { initializeCollaborationSchema } from "../src/infrastructure/initializeCollaborationSchema.ts";
import type { CollaborationDatabase } from "../src/infrastructure/schema.ts";

/**
 * Collaboration package単体の相談の規則（状態遷移・版・応答lease・方針変更・根拠）とschemaの制約。
 * 認可・Projectの状態・Web/MCPの入口はserverのテスト（consultation.test.ts）で検証する。
 */

const lease = (overrides: Partial<ConsultationLease> = {}): ConsultationLease => ({
  id: "lease-1",
  consultationId: "c1",
  inputRevision: 2,
  principalId: "manager-a",
  role: "manager",
  acquiredAt: 1_000,
  expiresAt: 2_000,
  releasedAt: null,
  ...overrides,
});

test("Humanの発言はAgentの応答待ち、Agentの発言はHumanの判断待ちへ進め、解決・取消後は追記できない", () => {
  assert.equal(statusAfterMessage("human"), "waiting_agent");
  assert.equal(statusAfterMessage("agent"), "waiting_human");
  assert.equal(checkHumanMessage({ status: "waiting_human" }), null);
  assert.equal(checkHumanMessage({ status: "waiting_agent" }), null);
  assert.equal(checkHumanMessage({ status: "resolved" }), "CONSULTATION_CLOSED");
  assert.equal(checkHumanMessage({ status: "canceled" }), "CONSULTATION_CLOSED");
});

test("Humanの明示決定・取消は閲覧した版が現在の版のときだけ受け付ける", () => {
  assert.equal(checkHumanClosing({ status: "waiting_human", revision: 3 }, 3), null);
  assert.equal(checkHumanClosing({ status: "waiting_agent", revision: 3 }, 2), "STALE_REVISION");
  assert.equal(checkHumanClosing({ status: "resolved", revision: 3 }, 3), "CONSULTATION_CLOSED");
});

test("応答leaseはHumanの新しい入力の現在の版に1つだけで、同じPrincipalは取り直せる", () => {
  const waiting = { status: "waiting_agent" as const, revision: 2 };
  assert.equal(checkLeaseAcquisition(waiting, 2, null, "manager-a"), null);
  assert.equal(checkLeaseAcquisition(waiting, 2, lease(), "manager-a"), null);
  assert.equal(checkLeaseAcquisition(waiting, 2, lease(), "manager-b"), "LEASE_HELD");
  assert.equal(checkLeaseAcquisition(waiting, 1, null, "manager-a"), "STALE_REVISION");
  assert.equal(checkLeaseAcquisition({ status: "waiting_human", revision: 2 }, 2, null, "manager-a"), "NOT_WAITING_AGENT");
  assert.equal(checkLeaseAcquisition({ status: "canceled", revision: 2 }, 2, null, "manager-a"), "CONSULTATION_CLOSED");
  assert.equal(isLeaseActive(lease(), { revision: 2 }, 1_999), true);
  assert.equal(isLeaseActive(lease(), { revision: 2 }, 2_000), false);
  assert.equal(isLeaseActive(lease(), { revision: 3 }, 1_500), false);
  assert.equal(isLeaseActive(lease({ releasedAt: 1_200 }), { revision: 2 }, 1_500), false);
});

test("Agentの応答は現在の版・自分の未使用で期限内のleaseを要求する", () => {
  const waiting = { status: "waiting_agent" as const, revision: 2 };
  assert.equal(checkAgentResponse(waiting, 2, lease(), "manager-a", 1_500), null);
  assert.equal(checkAgentResponse(waiting, 1, lease(), "manager-a", 1_500), "STALE_REVISION");
  assert.equal(checkAgentResponse(waiting, 2, null, "manager-a", 1_500), "LEASE_NOT_HELD");
  assert.equal(checkAgentResponse(waiting, 2, lease(), "manager-b", 1_500), "LEASE_NOT_HELD");
  assert.equal(checkAgentResponse(waiting, 2, lease({ releasedAt: 1_100 }), "manager-a", 1_500), "LEASE_NOT_HELD");
  assert.equal(checkAgentResponse(waiting, 2, lease(), "manager-a", 2_000), "LEASE_EXPIRED");
  assert.equal(checkAgentResponse({ status: "waiting_agent", revision: 3 }, 3, lease(), "manager-a", 1_500), "STALE_REVISION");
  assert.equal(checkAgentResponse({ status: "waiting_human", revision: 2 }, 2, lease(), "manager-a", 1_500), "NOT_WAITING_AGENT");
});

test("方針変更は解決・取消済みの相談だけを参照でき、Agentの結論にはHumanの発言の根拠が要る", () => {
  assert.equal(checkSupersedes({ status: "resolved" }), null);
  assert.equal(checkSupersedes({ status: "canceled" }), null);
  assert.equal(checkSupersedes({ status: "waiting_human" }), "SUPERSEDED_NOT_CLOSED");
  const human = { author: { kind: "human" as const, principalId: "human:h1", role: "operator" } };
  const agent = { author: { kind: "agent" as const, principalId: "worker-a", role: "worker" } };
  assert.equal(hasHumanBasis([agent, human]), true);
  assert.equal(hasHumanBasis([agent]), false);
  assert.equal(hasHumanBasis([]), false);
});

test("schemaは冪等に作成でき、状態・判断の由来と記録主体の組・取消の理由・発言の順序をDBでも制約する", async () => {
  const sqlite = new BetterSqlite3(":memory:");
  sqlite.pragma("foreign_keys = ON");
  const database = new Kysely<CollaborationDatabase>({ dialect: new SqliteDialect({ database: sqlite }) });
  await sql`create table workspace (id text primary key)`.execute(database);
  await sql`create table project (id text primary key)`.execute(database);
  await sql`insert into workspace (id) values ('w1')`.execute(database);
  await sql`insert into project (id) values ('p1')`.execute(database);
  await initializeCollaborationSchema(database);
  await initializeCollaborationSchema(database);
  const consultation = {
    id: "c1", workspace_id: "w1", project_id: "p1", title: "t", question: "q", blocking_reason: "b", options: "[]",
    recommendation: "r", impact: "i", refs: "[]", status: "waiting_human", revision: 1, supersedes_consultation_id: null,
    created_by_kind: "agent", created_by_principal_id: "worker-a", created_by_role: "worker", created_at: 1, updated_at: 1,
    cancel_reason: null, canceled_by_kind: null, canceled_by_principal_id: null, canceled_by_role: null, canceled_at: null,
  };
  await database.insertInto("consultation").values(consultation).execute();
  await assert.rejects(database.insertInto("consultation").values({ ...consultation, id: "c2", status: "open" }).execute(), /CHECK/);
  await assert.rejects(database.insertInto("consultation").values({ ...consultation, id: "c3", status: "canceled" }).execute(), /CHECK/);
  const message = { id: "m1", consultation_id: "c1", sequence: 1, author_kind: "human", principal_id: "human:h1", role: "operator", body: "x", corrects_message_id: null, revision: 2, created_at: 2 };
  await database.insertInto("consultation_message").values(message).execute();
  await assert.rejects(database.insertInto("consultation_message").values({ ...message, id: "m2" }).execute(), /UNIQUE/);
  const resolution = {
    id: "r1", consultation_id: "c1", source: "human_decision", conclusion: "c", rationale: "r", applicability: null, selected_option: null,
    basis_message_ids: "[]", basis_revision: 2, recorded_by_kind: "agent", recorded_by_principal_id: "manager-a", recorded_by_role: "manager", created_at: 3,
  };
  await assert.rejects(database.insertInto("consultation_resolution").values(resolution).execute(), /CHECK/);
  await database.insertInto("consultation_resolution").values({ ...resolution, source: "agent_summary" }).execute();
  await assert.rejects(database.insertInto("consultation_resolution").values({ ...resolution, id: "r2", source: "agent_summary" }).execute(), /UNIQUE/);
  await database.destroy();
});
