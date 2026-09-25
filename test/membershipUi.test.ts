import assert from "node:assert/strict";
import test from "node:test";
import { currentProjectOperationResult, projectOperationAccess, projectOperationDeniedMessage } from "../src/frontend/projectAccess.ts";
import { classifyError, onSessionLost, request, setCsrfToken, withCsrf } from "../src/frontend/api.ts";
import {
  loginErrorMessage,
  loginPath,
  normalizeReturnTo,
  readInvitationToken,
} from "../src/frontend/features/auth/auth.ts";
import {
  changeRoleInit,
  invitationDisplayStatus,
  invitationExpiryOptions,
  invitationInit,
  invitationsPath,
  isLastOwner,
  membersPath,
  type HumanRole,
  type Member,
} from "../src/frontend/features/member/members.ts";
import { hasMinimumRole, humanProjectPermissions, invitationMaxTtlHours, invitationMinTtlHours } from "../src/domain/model/HumanAuth.ts";

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

const member = (id: string, role: HumanRole): Member => ({
  membership: { id, projectId: "p1", humanUserId: `h-${id}`, role, createdAt: 0, updatedAt: 0 },
  human: { id: `h-${id}`, displayName: id, email: `${id}@example.com` },
});

test("非安全methodだけにCSRF headerを付け、既存headerを保つ。tokenが無ければ変更しない", async () => {
  assert.equal(withCsrf(undefined, "t1"), undefined);
  assert.equal(withCsrf({ method: "GET" }, "t1")?.headers, undefined);
  const patched = withCsrf(changeRoleInit("editor"), "t1")!;
  const headers = new Headers(patched.headers);
  assert.equal(headers.get("X-Compass-CSRF"), "t1");
  assert.equal(headers.get("Content-Type"), "application/json");
  assert.equal(withCsrf({ method: "DELETE" }, null)?.headers, undefined);

  const seen: Headers[] = [];
  setCsrfToken("session-csrf");
  try {
    await request("/x", { method: "POST" }, async (_path, init) => {
      seen.push(new Headers(init?.headers));
      return jsonResponse(200, {});
    });
  } finally {
    setCsrfToken(null);
  }
  assert.equal(seen[0]?.get("X-Compass-CSRF"), "session-csrf");
});

test("401とCSRF不一致はSession切れを通知し、入力が残っていることを示す文言にする。FORBIDDENは権限不足として区別する", async () => {
  let lost = 0;
  onSessionLost(() => { lost += 1; });
  try {
    const unauthenticated = await failureOf(401, { error: { code: "UNAUTHENTICATED", message: "A valid session is required" } });
    assert.equal(unauthenticated.kind, "other");
    assert.match(unauthenticated.kind === "other" ? unauthenticated.message : "", /入力内容はこの画面に残っています/);
    await failureOf(403, { error: { code: "CSRF_REJECTED", message: "x" } });
    assert.equal(lost, 2);
    const forbidden = await failureOf(403, { error: { code: "FORBIDDEN", message: "x", requiredRole: "owner" } });
    assert.equal(lost, 2);
    assert.match(forbidden.kind === "other" ? forbidden.message : "", /権限がありません/);
    const network = await (async () => {
      try {
        await request("/x", undefined, async () => { throw new TypeError("offline"); });
      } catch (error) {
        return classifyError(error);
      }
    })();
    assert.deepEqual(network, { kind: "other", message: "サーバーに接続できませんでした" });
    assert.equal(lost, 2);
  } finally {
    onSessionLost(null);
  }
});

test("最後のowner・招待の重複・取消不可の409を日本語の説明にする", async () => {
  const lastOwner = await failureOf(409, { error: { code: "CONFLICT", message: "must keep at least one owner", conflict: "LAST_OWNER" } });
  assert.equal(lastOwner.kind, "conflict");
  assert.match(lastOwner.kind === "conflict" ? lastOwner.message : "", /少なくとも1人のowner/);
  const pending = await failureOf(409, { error: { code: "CONFLICT", message: "x", conflict: "INVITATION_PENDING" } });
  assert.match(pending.kind === "conflict" ? pending.message : "", /有効な招待が既にあります/);
  const archived = await failureOf(409, { error: { code: "CONFLICT", message: "x", projectStatus: "archived" } });
  assert.equal(archived.kind, "project_archived");
});

test("Membership・招待のrequestはWeb APIと同じpath・本文を使う", () => {
  assert.equal(membersPath("p1"), "/api/projects/p1/members");
  assert.equal(membersPath("p1", "m1"), "/api/projects/p1/members/m1");
  assert.equal(invitationsPath("p1", "i1"), "/api/projects/p1/invitations/i1");
  assert.equal(changeRoleInit("viewer").method, "PATCH");
  assert.deepEqual(JSON.parse(String(changeRoleInit("viewer").body)), { role: "viewer" });
  const invite = invitationInit("a@example.com", "editor", 24);
  assert.equal(invite.method, "POST");
  assert.deepEqual(JSON.parse(String(invite.body)), { email: "a@example.com", role: "editor", expiresInHours: 24 });
  for (const option of invitationExpiryOptions) {
    assert.ok(option.hours >= invitationMinTtlHours && option.hours <= invitationMaxTtlHours);
  }
});

test("招待の表示状態は期限切れのpendingを期限切れとして区別し、最後のownerだけ変更の導線を無効にする", () => {
  assert.equal(invitationDisplayStatus({ status: "pending", expiresAt: 100 }, 99), "pending");
  assert.equal(invitationDisplayStatus({ status: "pending", expiresAt: 100 }, 100), "expired");
  assert.equal(invitationDisplayStatus({ status: "accepted", expiresAt: 100 }, 200), "accepted");
  assert.equal(invitationDisplayStatus({ status: "revoked", expiresAt: 100 }, 50), "revoked");

  const soleOwner = member("a", "owner");
  const editor = member("b", "editor");
  assert.equal(isLastOwner([soleOwner, editor], soleOwner), true);
  assert.equal(isLastOwner([soleOwner, editor], editor), false);
  const secondOwner = member("c", "owner");
  assert.equal(isLastOwner([soleOwner, secondOwner], soleOwner), false);
});

test("ログインの戻り先は同一origin内の相対pathだけにし、ログイン・招待画面へは戻さない", () => {
  assert.equal(normalizeReturnTo("/projects/p1?x=1"), "/projects/p1?x=1");
  for (const value of [null, "", "https://evil.example", "//evil.example", "/\\evil", "/a\nb", "/login", "/login?error=x", "/invite"]) {
    assert.equal(normalizeReturnTo(value), "/", String(value));
  }
  assert.equal(normalizeReturnTo("/logins"), "/logins");
  assert.equal(loginPath("/"), "/login");
  assert.equal(loginPath("/projects/p1"), "/login?returnTo=%2Fprojects%2Fp1");
  assert.equal(loginPath("//evil", "session_expired"), "/login?error=session_expired");
});

test("ログインの拒否理由を区別して表示し、未知のcodeは汎用文言にする", () => {
  assert.equal(loginErrorMessage(null), null);
  assert.match(loginErrorMessage("not_allowed")!.title, /利用できません/);
  assert.match(loginErrorMessage("invitation_expired")!.detail, /再発行/);
  assert.match(loginErrorMessage("oidc_failed")!.title, /Google/);
  assert.equal(loginErrorMessage("<script>")!.title, "ログインできませんでした。");
});

test("招待tokenはURL fragmentからだけ読み、形式が不正なら読まない", () => {
  const token = "a".repeat(43);
  assert.equal(readInvitationToken(`#${token}`), token);
  assert.equal(readInvitationToken(token), token);
  assert.equal(readInvitationToken(""), null);
  assert.equal(readInvitationToken("#short"), null);
  assert.equal(readInvitationToken(`#${token}&x=1`), null);
});

// `src/frontend/useProjectAccess.ts`と同じ組み合わせ（`canOperate`はdomainの権限表を使うが、serverのtsconfigで読めないため直接使う）。
const access = (project: { status: "active" | "archived" }, myRole: HumanRole | null, operation: keyof typeof humanProjectPermissions) =>
  projectOperationAccess(project, myRole !== null && hasMinimumRole(myRole, humanProjectPermissions[operation]));

// 画面経路（viewer / editor / administrator / owner、archived、URL直アクセス）の表示はブラウザで確認し、Task 43のコメントに記録した。
test("Intent・Outcome詳細の書込導線はdomainの権限表（direction.write）とProjectのstatusで決め、viewerとarchivedでは出さない", () => {
  const active = { status: "active" as const };
  const archived = { status: "archived" as const };
  assert.equal(access(active, "viewer", "direction.write"), "forbidden");
  assert.equal(access(active, null, "direction.write"), "forbidden");
  for (const role of ["editor", "administrator", "owner"] as const) {
    assert.equal(access(active, role, "direction.write"), "allowed", role);
    assert.equal(access(archived, role, "direction.write"), "archived", role);
  }
});

test("作成・編集画面へURLで直接来ても、操作できなければフォームの代わりにarchivedと権限不足を区別した理由を出す", () => {
  assert.equal(access({ status: "active" }, "editor", "project.update"), "forbidden");
  assert.equal(access({ status: "active" }, "administrator", "project.update"), "allowed");
  assert.equal(access({ status: "archived" }, "viewer", "direction.write"), "archived");
  assert.match(projectOperationDeniedMessage("archived"), /アーカイブ済み/);
  assert.match(projectOperationDeniedMessage("forbidden"), /権限がありません/);
});

test("同じ画面のままProject IDや操作が変わった直後は、前のProjectの判定結果を使わず取得中として扱う", () => {
  const allowedA = { projectId: "project-a", operation: "direction.write", result: { access: "allowed" as const } };
  assert.deepEqual(currentProjectOperationResult(allowedA, "project-a", "direction.write"), { access: "allowed" });
  assert.equal(currentProjectOperationResult(allowedA, "project-b", "direction.write"), null);
  assert.equal(currentProjectOperationResult(allowedA, "project-a", "project.update"), null);
  assert.equal(currentProjectOperationResult(null, "project-a", "direction.write"), null);
});
