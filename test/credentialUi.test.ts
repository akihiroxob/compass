import assert from "node:assert/strict";
import test from "node:test";
import {
  allRuntimeScopes,
  credentialStatus,
  credentialsPath,
  issueCredentialInit,
  rotateCredentialInit,
  rotateCredentialPath,
} from "../src/frontend/features/credential/credentials.ts";
import { runtimeScopes } from "../src/domain/model/AccessCredential.ts";
import { hasMinimumRole, humanProjectPermissions, type HumanRole } from "../src/domain/model/HumanAuth.ts";

// `src/frontend/permissions.ts`の`canOperate`と同じ判定（frontendのmoduleはserverのtsconfigで読めないためdomainの権限表を直接使う）。
const canOperate = (role: HumanRole | null, operation: keyof typeof humanProjectPermissions) =>
  role !== null && hasMinimumRole(role, humanProjectPermissions[operation]);

test("Credential管理の導線はAdministrator以上だけに出す", () => {
  assert.equal(canOperate("owner", "credential.manage"), true);
  assert.equal(canOperate("administrator", "credential.manage"), true);
  assert.equal(canOperate("editor", "credential.manage"), false);
  assert.equal(canOperate("viewer", "credential.manage"), false);
  assert.equal(canOperate(null, "credential.manage"), false);
});

test("発行requestはAgentにscopeを送らず、Runtimeだけ選んだscopeを送る", () => {
  assert.deepEqual(JSON.parse(String(issueCredentialInit("agent", "worker-a", allRuntimeScopes, 90).body)), {
    kind: "agent",
    principalId: "worker-a",
    expiresInDays: 90,
  });
  assert.deepEqual(JSON.parse(String(issueCredentialInit("runtime", "rt", ["runtime:event:read"], 30).body)), {
    kind: "runtime",
    principalId: "rt",
    scopes: ["runtime:event:read"],
    expiresInDays: 30,
  });
  assert.deepEqual(JSON.parse(String(rotateCredentialInit(24).body)), { graceHours: 24 });
  assert.equal(credentialsPath("p1"), "/api/projects/p1/credentials");
  assert.equal(rotateCredentialPath("p1", "c1"), "/api/projects/p1/credentials/c1/rotate");
});

test("画面のscope選択肢はserverのscopeと一致し、状態は取消・期限から判定する", () => {
  assert.deepEqual([...allRuntimeScopes].sort(), [...runtimeScopes].sort());
  assert.equal(credentialStatus({ expiresAt: 10, revokedAt: null }, 5), "active");
  assert.equal(credentialStatus({ expiresAt: 10, revokedAt: null }, 10), "expired");
  assert.equal(credentialStatus({ expiresAt: 10, revokedAt: 3 }, 5), "revoked");
});
