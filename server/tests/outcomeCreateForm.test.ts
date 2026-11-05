import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CreateWorkspaceUseCase, SQLiteWorkspaceRepository } from "@compass/organization";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { asOrganizationDatabase } from "../src/bootstrap/database/contextDatabase.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { initializeSchema } from "../src/bootstrap/database/initializeSchema.ts";
import { createOutcomeBody, emptyCriterion, emptyOutcomeFormValues } from "../src/web/features/outcome/outcome.ts";
import { createSignedInApp } from "./support/humanSession.ts";

/** HumanのOutcome登録フォームが組み立てる本文を、公開Web APIへそのまま送って結果を確認する。 */
const values = { ...emptyOutcomeFormValues, title: "Form outcome", description: "達成状態", rationale: "判断理由", successCriteria: [{ ...emptyCriterion, description: "条件", measurement: "測定" }] };

test("フォームの本文は判断元のIntent版を含み、登録できる。入力中にIntentが更新されていれば競合にし、現在版へ付け替えない", async () => {
  const directory = mkdtempSync(join(tmpdir(), "compass-outcome-form-"));
  try {
    const database = createDatabase(join(directory, "compass.db"));
    await initializeSchema(database);
    const services = createApplicationServices(database, undefined, () => 1_800_000_000_000);
    const app = await createSignedInApp(database, services);
    const post = (path: string, body: object, method = "POST") => app.request(path, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const workspace = await new CreateWorkspaceUseCase(new SQLiteWorkspaceRepository(asOrganizationDatabase(database))).execute({ name: "Workspace", mission: "Mission" });
    const workspaceId = workspace.id;
    const base = `/api/workspaces/${workspaceId}/intents`;
    const created = (await (await post(base, { title: "目標", desiredState: "状態" })).json()) as { intent: { id: string; version: number } };
    const { id, version } = created.intent;

    // 画面を開いた時点の版を保持して送る → 登録できる。
    const ok = await post(`${base}/${id}/outcomes`, createOutcomeBody(values, version));
    assert.ok([200, 201].includes(ok.status), `status ${ok.status}`);
    assert.equal(((await ok.json()) as { outcome: { intentVersion: number } }).outcome.intentVersion, version);

    // 入力中に別画面が目標を更新した → 保持した旧版のまま送ると競合。版を黙って付け替えない。
    assert.equal((await post(`${base}/${id}`, { expectedVersion: version, title: "更新後" }, "PATCH")).status, 200);
    const stale = await post(`${base}/${id}/outcomes`, createOutcomeBody({ ...values, title: "古い判断" }, version));
    assert.equal(stale.status, 409);

    // 版を含まない本文は入力エラー（Serverは省略を許可しない）。
    const { intentVersion: _omitted, ...withoutVersion } = createOutcomeBody(values, version);
    assert.equal((await post(`${base}/${id}/outcomes`, withoutVersion)).status, 400);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
