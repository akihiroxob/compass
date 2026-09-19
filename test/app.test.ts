import assert from "node:assert/strict";
import test from "node:test";
import { createApp } from "../src/app.ts";

test("health and api are served by the same app", async () => {
  const app = createApp();
  const [health, api] = await Promise.all([
    app.request("/health"),
    app.request("/api"),
  ]);

  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok", service: "compass" });
  assert.equal(api.status, 200);
});
