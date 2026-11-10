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

test("injected static assets serve SPA paths after API routes without hiding API errors", async () => {
  const database = createDatabase(":memory:");
  let staticCalls = 0;
  const app = createApp(createApplicationServices(database), {
    staticAssets: {
      files: async (c, next) => {
        staticCalls++;
        if (c.req.path === "/assets/app.js") return c.text("asset");
        await next();
      },
      index: async (c) => c.html('<div id="root"></div>'),
    },
  });
  try {
    assert.equal((await app.request("/health")).status, 200);
    assert.equal((await app.request("/api/missing")).status, 404);
    assert.equal(staticCalls, 0);
    assert.equal(await (await app.request("/assets/app.js")).text(), "asset");
    assert.match(await (await app.request("/workspaces/example")).text(), /id="root"/);
  } finally {
    await database.destroy();
  }
});
