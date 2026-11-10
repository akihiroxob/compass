import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/presentation/http/createApp.ts";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";

test("health and api are served by the same app", async () => {
  const database = createDatabase(":memory:");
  const app = createApp(createApplicationServices(database));
  const [health, api] = await Promise.all([
    app.request("/health"),
    app.request("/api"),
  ]);

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "compass" });
  assert.equal(api.status, 200);
  await database.destroy();
});
