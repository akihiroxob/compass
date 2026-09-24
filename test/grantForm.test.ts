import assert from "node:assert/strict";
import test from "node:test";
import { ApiError, classifyError, describeActionFailure, request, withNotFoundMessage } from "../src/frontend/api.ts";
import {
  grantInit,
  grantNotice,
  grantsPath,
  revokeGrantPath,
  revokeInit,
} from "../src/frontend/features/grant/grants.ts";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const failureOf = async (status: number, body: unknown) => {
  try {
    await request("/x", undefined, async () => jsonResponse(status, body));
  } catch (error) {
    return classifyError(error);
  }
  assert.fail("request should reject");
};

test("発行はWeb APIと同じ本文（principalIdと指定したrole）、取消はpathにURLエンコードしたprincipalIdを置く", () => {
  assert.equal(grantsPath("p1"), "/api/projects/p1/grants");
  assert.deepEqual(grantInit("strat-1", "strategist").method, "POST");
  assert.deepEqual(JSON.parse(String(grantInit("strat-1", "strategist").body)), { principalId: "strat-1", role: "strategist" });
  assert.deepEqual(JSON.parse(String(grantInit("res-1", "researcher").body)), { principalId: "res-1", role: "researcher" });
  assert.equal(
    revokeGrantPath("p1", { role: "strategist", principalId: "team/agent 1" }),
    "/api/projects/p1/grants/strategist/team%2Fagent%201",
  );
  assert.equal(
    revokeGrantPath("p1", { role: "researcher", principalId: "res-1" }),
    "/api/projects/p1/grants/researcher/res-1",
  );
  assert.equal(revokeInit.method, "DELETE");
});

test("新規発行と割当済みの再発行を区別して通知し、roleごとの名称を使う", () => {
  assert.match(grantNotice(true, "strat-1", "strategist"), /strat-1.*Strategist.*割り当てました/);
  assert.match(grantNotice(false, "strat-1", "strategist"), /strat-1.*Strategist.*割り当て済み/);
  assert.match(grantNotice(true, "res-1", "researcher"), /res-1.*Researcher.*割り当てました/);
});

test("Execution（Manager・Worker・Reviewer）のRoleもWeb APIと同じ本文で発行・取消できる", () => {
  for (const [role, label] of [["manager", "Manager"], ["worker", "Worker"], ["reviewer", "Reviewer"]] as const) {
    assert.deepEqual(JSON.parse(String(grantInit("agent-1", role).body)), { principalId: "agent-1", role });
    assert.equal(revokeGrantPath("p1", { role, principalId: "agent-1" }), `/api/projects/p1/grants/${role}/agent-1`);
    assert.match(grantNotice(true, "agent-1", role), new RegExp(`agent-1.*${label}.*割り当てました`));
  }
});

test("400はprincipalIdのfield idとAgent名ラベルへ対応づけ、入力の再送信を妨げない", async () => {
  const classified = await failureOf(400, {
    error: { code: "VALIDATION_ERROR", message: "Grant input is invalid", issues: [{ path: "principalId", message: "principalId is required" }] },
  });
  assert.deepEqual(withNotFoundMessage(classified, "Projectが見つかりません。削除された可能性があります。"), {
    kind: "validation",
    issues: [{ fieldId: "field-principalId", label: "Agent名", message: "principalId is required" }],
  });
});

test("存在しないProject・通信障害は区別した文言になる", async () => {
  const notFound = await failureOf(404, { error: { code: "NOT_FOUND", message: "Project p was not found" } });
  assert.deepEqual(withNotFoundMessage(notFound, "Projectが見つかりません。削除された可能性があります。"), { kind: "other", message: "Projectが見つかりません。削除された可能性があります。" });
  assert.equal(describeActionFailure(notFound, "Projectが見つかりません。"), "Projectが見つかりません。");

  const network = classifyError(new ApiError(0, "NETWORK_ERROR", "サーバーに接続できませんでした"));
  assert.equal(describeActionFailure(network, "Projectが見つかりません。"), "サーバーに接続できませんでした");
  assert.deepEqual(withNotFoundMessage(network, "x"), network);

  const validation = await failureOf(400, { error: { code: "VALIDATION_ERROR", message: "x", issues: [{ path: "role", message: "role must be one of: strategist" }] } });
  assert.equal(describeActionFailure(validation, "Projectが見つかりません。"), "Role: role must be one of: strategist");
});
