import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sql } from "kysely";
import { CreateProjectUseCase } from "../src/application/usecase/CreateProjectUseCase.ts";
import { GetProjectUseCase } from "../src/application/usecase/GetProjectUseCase.ts";
import { createDatabase } from "../src/infrastructure/database/createDatabase.ts";
import { initializeSchema } from "../src/infrastructure/database/initializeSchema.ts";
import { SQLiteProjectRepository } from "../src/infrastructure/repository/SQLiteProjectRepository.ts";

test("Project aggregate is persisted and survives reopening the database", async () => {
  const directory = await mkdtemp(join(tmpdir(), "compass-project-"));
  const path = join(directory, "test.db");
  const firstDatabase = createDatabase(path);
  await initializeSchema(firstDatabase);
  const createProject = new CreateProjectUseCase(new SQLiteProjectRepository(firstDatabase));

  const created = await createProject.execute({
    name: " Compass ",
    description: " Direction management ",
    mission: " Make direction explicit ",
    vision: " Agents improve software continuously ",
    principles: ["Trace decisions", "Persist state"],
    constraints: ["No secrets in repositories"],
    repositories: [{ name: "Compass", url: "https://github.com/example/compass" }],
    resources: [{ name: "Design", url: "https://example.com/design", kind: "docs" }],
  });
  await firstDatabase.destroy();

  const reopenedDatabase = createDatabase(path);
  await initializeSchema(reopenedDatabase);
  const found = await new GetProjectUseCase(
    new SQLiteProjectRepository(reopenedDatabase),
  ).execute(created.id);

  assert.equal(found.id, created.id);
  assert.equal(found.name, "Compass");
  assert.equal(found.mission, "Make direction explicit");
  assert.deepEqual(found.principles, ["Trace decisions", "Persist state"]);
  assert.deepEqual(found.constraints, ["No secrets in repositories"]);
  assert.equal(found.repositories[0]?.name, "Compass");
  assert.equal(found.resources[0]?.kind, "docs");

  await reopenedDatabase.destroy();
  await rm(directory, { recursive: true });
});

test("CreateProjectUseCase rejects invalid input", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const useCase = new CreateProjectUseCase(new SQLiteProjectRepository(database));

  await assert.rejects(
    () => useCase.execute({ name: " ", mission: "", repositories: [{ name: "x", url: "file:///tmp/x" }] }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "VALIDATION_ERROR");
      return true;
    },
  );
  await database.destroy();
});

test("GetProjectUseCase distinguishes a missing project", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const useCase = new GetProjectUseCase(new SQLiteProjectRepository(database));

  await assert.rejects(
    () => useCase.execute("missing"),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "NOT_FOUND");
      return true;
    },
  );
  await database.destroy();
});

test("Project children keep input order and a failed child insert rolls back the parent", async () => {
  const database = createDatabase(":memory:");
  await initializeSchema(database);
  const repository = new SQLiteProjectRepository(database);
  const createProject = new CreateProjectUseCase(repository);

  const created = await createProject.execute({
    name: "Ordered",
    mission: "Keep order",
    principles: ["c", "a", "b"],
    resources: [
      { name: "z", url: "https://example.com/z" },
      { name: "a", url: "https://example.com/a" },
    ],
  });
  assert.deepEqual(created.principles, ["c", "a", "b"]);
  assert.deepEqual(created.resources.map((resource) => resource.name), ["z", "a"]);

  await sql`CREATE TRIGGER fail_resource BEFORE INSERT ON project_resource
    BEGIN SELECT RAISE(ABORT, 'forced failure'); END`.execute(database);
  await assert.rejects(() =>
    createProject.execute({
      name: "Rolled back",
      mission: "Nothing is saved",
      resources: [{ name: "r", url: "https://example.com/r" }],
    }),
  );
  assert.deepEqual((await repository.findAll()).map((project) => project.name), ["Ordered"]);
  await database.destroy();
});
