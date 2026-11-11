import assert from "node:assert/strict";
import test from "node:test";
import { createD1TestRuntime, initializeD1TestSchema } from "./support/d1Runtime.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createD1AccessInfrastructure } from "../src/bootstrap/d1AccessInfrastructure.ts";
import { createD1OrganizationInfrastructure } from "../src/bootstrap/d1OrganizationInfrastructure.ts";
import { activityActorContext } from "../src/infrastructure/activity/NodeActivityActorContext.ts";
import { asAccessDatabase } from "../src/infrastructure/database/contextDatabase.ts";
import { createApp } from "../src/presentation/http/createApp.ts";

test("shared HTTP auth, Workspace, Grant and Credential routes use D1 repositories through DI", async () => {
  const { runtime, binding, database } = await createD1TestRuntime();
  try {
    await initializeD1TestSchema(binding);
    const services = createApplicationServices(database, undefined, Date.now, { initialOwnerEmail: "owner@example.test" }, {},
      createD1OrganizationInfrastructure(database, binding, activityActorContext), {
        access: createD1AccessInfrastructure(asAccessDatabase(database), binding, Date.now),
      });
    const origin = "http://localhost";
    const app = createApp(services, { humanAuth: { mode: "trusted-local", publicOrigin: origin } });
    const login = await app.request("/auth/local/login", { method: "POST", headers: { Origin: origin }, body: new URLSearchParams({ email: "owner@example.test" }) });
    assert.equal(login.status, 302, await login.clone().text());
    const cookie = login.headers.get("set-cookie")?.match(/compass_session=([^;]+)/)?.[0];
    assert.ok(cookie);
    const session = await app.request("/api/auth/session", { headers: { Cookie: cookie } });
    assert.equal(session.status, 200);
    const { csrfToken } = await session.json() as { csrfToken: string };
    const request = (path: string, method = "GET", body?: object) => app.request(path, { method,
      headers: { Cookie: cookie, Origin: origin, "X-Compass-CSRF": csrfToken, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const created = await request("/api/workspaces", "POST", { name: "Business", mission: "Goal" });
    assert.equal(created.status, 201, await created.clone().text());
    const { workspace } = await created.json() as { workspace: { id: string } };
    const projectResponse = await request(`/api/workspaces/${workspace.id}/projects`, "POST", { name: "Product" });
    assert.equal(projectResponse.status, 201, await projectResponse.clone().text());
    const { project } = await projectResponse.json() as { project: { id: string } };
    const grant = await request(`/api/projects/${project.id}/grants`, "POST", { role: "worker", principalId: "worker" });
    assert.equal(grant.status, 201, await grant.clone().text());
    const issued = await request(`/api/projects/${project.id}/credentials`, "POST", { kind: "agent", principalId: "worker" });
    assert.equal(issued.status, 201, await issued.clone().text());
    const { token, credential } = await issued.json() as { token: string; credential: { id: string } };
    const caller = await services.authenticateAccessCredentialUseCase.execute(token);
    assert.ok(caller);
    const rotated = await request(`/api/projects/${project.id}/credentials/${credential.id}/rotate`, "POST", {});
    assert.equal(rotated.status, 201, await rotated.clone().text());
    assert.equal((await request("/api/auth/logout", "POST")).status, 204);
    assert.equal((await request(`/api/workspaces/${workspace.id}`)).status, 401);
  } finally {
    await database.destroy();
    await runtime.dispose();
  }
});
