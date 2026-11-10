import assert from "node:assert/strict";
import test from "node:test";
import { createApplicationServices } from "../src/bootstrap/createApplicationServices.ts";
import { createDatabase } from "../src/bootstrap/database/createDatabase.ts";
import { createSqliteOrganizationInfrastructure } from "../src/bootstrap/organizationInfrastructure.ts";

test("OrganizationのRepositoryを注入するとProject一覧はその契約を使う", async () => {
  const database = createDatabase(":memory:");
  try {
    const sqlite = createSqliteOrganizationInfrastructure(database);
    const calls: string[] = [];
    const projectRepository = new Proxy(sqlite.projectRepository, {
      get(target, property, receiver) {
        if (property === "findAll") return async (status: string) => { calls.push(status); return []; };
        return Reflect.get(target, property, receiver);
      },
    });
    const services = createApplicationServices(database, undefined, undefined, undefined, undefined, {
      ...sqlite, projectRepository,
    });
    assert.deepEqual(await services.listProjectsUseCase.execute(), []);
    assert.deepEqual(calls, ["active"]);
  } finally {
    await database.destroy();
  }
});
