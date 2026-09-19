import type { Kysely, Transaction } from "kysely";
import { Project } from "../../domain/model/Project.ts";
import type { ProjectRepository } from "../../domain/repository/ProjectRepository.ts";
import type { CreateProjectInput } from "../../shared/projectSchema.ts";
import type { Database } from "../database/schema.ts";

type Queryable = Kysely<Database> | Transaction<Database>;

export class SQLiteProjectRepository implements ProjectRepository {
  constructor(private readonly database: Kysely<Database>) {}

  async create(input: CreateProjectInput): Promise<Project> {
    const id = crypto.randomUUID();
    const now = Date.now();

    await this.database.transaction().execute(async (transaction) => {
      await transaction
        .insertInto("project")
        .values({
          id,
          name: input.name,
          description: input.description,
          mission: input.mission,
          vision: input.vision,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (input.principles.length) {
        await transaction.insertInto("project_principle").values(
          input.principles.map((value, sortOrder) => ({
            id: crypto.randomUUID(), project_id: id, value, sort_order: sortOrder,
          })),
        ).execute();
      }
      if (input.constraints.length) {
        await transaction.insertInto("project_constraint").values(
          input.constraints.map((value, sortOrder) => ({
            id: crypto.randomUUID(), project_id: id, value, sort_order: sortOrder,
          })),
        ).execute();
      }
      if (input.repositories.length) {
        await transaction.insertInto("project_repository_link").values(
          input.repositories.map((item, sortOrder) => ({
            id: crypto.randomUUID(), project_id: id, ...item, sort_order: sortOrder,
          })),
        ).execute();
      }
      if (input.resources.length) {
        await transaction.insertInto("project_resource").values(
          input.resources.map((item, sortOrder) => ({
            id: crypto.randomUUID(), project_id: id, ...item, sort_order: sortOrder,
          })),
        ).execute();
      }
    });

    return (await this.findById(id))!;
  }

  async findAll(): Promise<Project[]> {
    const rows = await this.database.selectFrom("project").select("id").execute();
    return Promise.all(rows.map(async ({ id }) => (await this.findById(id))!));
  }

  async findById(projectId: string): Promise<Project | null> {
    const row = await this.database
      .selectFrom("project")
      .selectAll()
      .where("id", "=", projectId)
      .executeTakeFirst();
    if (!row) return null;

    const [principles, constraints, repositories, resources] = await Promise.all([
      this.orderedValues(this.database, "project_principle", projectId),
      this.orderedValues(this.database, "project_constraint", projectId),
      this.database.selectFrom("project_repository_link").select(["id", "name", "url"])
        .where("project_id", "=", projectId).orderBy("sort_order").execute(),
      this.database.selectFrom("project_resource").select(["id", "name", "url", "kind"])
        .where("project_id", "=", projectId).orderBy("sort_order").execute(),
    ]);

    return new Project({
      id: row.id,
      name: row.name,
      description: row.description,
      mission: row.mission,
      vision: row.vision,
      principles,
      constraints,
      repositories,
      resources,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
  }

  private async orderedValues(
    database: Queryable,
    table: "project_principle" | "project_constraint",
    projectId: string,
  ): Promise<string[]> {
    const rows = await database.selectFrom(table).select("value")
      .where("project_id", "=", projectId).orderBy("sort_order").execute();
    return rows.map(({ value }) => value);
  }
}
