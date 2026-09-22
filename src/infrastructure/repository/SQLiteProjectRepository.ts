import type { Kysely, Transaction } from "kysely";
import { Project, type ProjectStatus } from "../../domain/model/Project.ts";
import type {
  ArchiveProjectResult,
  ProjectRepository,
  RepositoryReferencedResult,
  UpdateProjectResult,
} from "../../domain/repository/ProjectRepository.ts";
import type { CreateProjectInput, UpdateProjectInput } from "../../shared/projectSchema.ts";
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
          status: "active",
          archived_at: null,
          archive_reason: null,
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

  async update(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("project")
        .select("status")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return "not_found" as const;
      if (existing.status === "archived") return "project_archived" as const;

      // Repositoryを外す変更はADR Handoff Request/Referenceの参照先を失わせないか、他の書込より先に検査する。
      // 途中まで書き込んでから拒否すると、そのtransactionはKyselyの仕様上そのまま commit されてしまうため。
      if (input.repositories) {
        const conflict = await this.findRepositoryRemovalConflict(transaction, projectId, input.repositories);
        if (conflict) return conflict;
      }

      // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
      await transaction
        .updateTable("project")
        .set({
          name: input.name,
          description: input.description,
          mission: input.mission,
          vision: input.vision,
          updated_at: Date.now(),
        })
        .where("id", "=", projectId)
        .execute();

      if (input.principles) {
        await this.replaceOrderedValues(transaction, "project_principle", projectId, input.principles);
      }
      if (input.constraints) {
        await this.replaceOrderedValues(transaction, "project_constraint", projectId, input.constraints);
      }
      if (input.repositories) await this.syncRepositories(transaction, projectId, input.repositories);
      if (input.resources) await this.syncResources(transaction, projectId, input.resources);
      return "updated" as const;
    });

    if (outcome === "not_found" || outcome === "project_archived") return { kind: outcome };
    if (outcome !== "updated") return outcome;
    return { kind: "updated", project: (await this.findById(projectId))! };
  }

  async archive(projectId: string, reason: string): Promise<ArchiveProjectResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("project")
        .select("status")
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return "not_found" as const;
      if (existing.status === "archived") return "already_archived" as const;

      // updated_atはarchived_atと同じ値にする（Intentの放棄・Outcomeの取消がupdated_atを更新するのと同じ）。
      const now = Date.now();
      await transaction
        .updateTable("project")
        .set({ status: "archived", archived_at: now, archive_reason: reason, updated_at: now })
        .where("id", "=", projectId)
        .execute();
      return "archived" as const;
    });

    if (outcome !== "archived") return { kind: outcome };
    return { kind: "archived", project: (await this.findById(projectId))! };
  }

  async findAll(status: ProjectStatus = "active"): Promise<Project[]> {
    const rows = await this.database
      .selectFrom("project")
      .select("id")
      .where("status", "=", status)
      .execute();
    return Promise.all(rows.map(async ({ id }) => (await this.findById(id))!));
  }

  async exists(projectId: string): Promise<boolean> {
    const row = await this.database
      .selectFrom("project")
      .select("id")
      .where("id", "=", projectId)
      .executeTakeFirst();
    return row !== undefined;
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
      status: row.status,
      archivedAt: row.archived_at,
      archiveReason: row.archive_reason,
    });
  }

  private async replaceOrderedValues(
    transaction: Transaction<Database>,
    table: "project_principle" | "project_constraint",
    projectId: string,
    values: string[],
  ): Promise<void> {
    await transaction.deleteFrom(table).where("project_id", "=", projectId).execute();
    if (!values.length) return;
    await transaction.insertInto(table).values(
      values.map((value, sortOrder) => ({
        id: crypto.randomUUID(), project_id: projectId, value, sort_order: sortOrder,
      })),
    ).execute();
  }

  /**
   * 入力から外れる既存Repositoryのうち、ADR Handoff Request/Reference（Task 28）から参照されている行が
   * あれば最初の1件を返す。`adr_handoff_request` / `adr_reference` の`repository_id`はonDelete cascadeを
   * 付けていない意図的な監査保持のため、削除前にdomainの`repository_referenced`として検査し拒否する。
   */
  private async findRepositoryRemovalConflict(
    transaction: Transaction<Database>,
    projectId: string,
    items: NonNullable<UpdateProjectInput["repositories"]>,
  ): Promise<RepositoryReferencedResult | null> {
    const existingRows = await transaction.selectFrom("project_repository_link").select(["id", "name"])
      .where("project_id", "=", projectId).execute();
    const keptIds = new Set(items.flatMap(({ id }) => (id !== undefined ? [id] : [])));
    const removed = existingRows.filter((row) => !keptIds.has(row.id));
    if (!removed.length) return null;

    const removedIds = removed.map((row) => row.id);
    const [handoffRow, referenceRow] = await Promise.all([
      transaction.selectFrom("adr_handoff_request").select("repository_id")
        .where("repository_id", "in", removedIds).executeTakeFirst(),
      transaction.selectFrom("adr_reference").select("repository_id")
        .where("repository_id", "in", removedIds).executeTakeFirst(),
    ]);
    const repositoryId = handoffRow?.repository_id ?? referenceRow?.repository_id;
    if (!repositoryId) return null;

    const repositoryName = removed.find((row) => row.id === repositoryId)?.name ?? repositoryId;
    return { kind: "repository_referenced", repositoryId, repositoryName };
  }

  /**
   * 入力のidがこのProjectの既存行と一致する場合だけ、その行を更新してidを維持する。
   * idなし・未知のid・他Projectのidは新規行として追加し、入力に現れない既存行は削除する。
   */
  private async syncRepositories(
    transaction: Transaction<Database>,
    projectId: string,
    items: NonNullable<UpdateProjectInput["repositories"]>,
  ): Promise<void> {
    const existingIds = new Set(
      (await transaction.selectFrom("project_repository_link").select("id")
        .where("project_id", "=", projectId).execute()).map(({ id }) => id),
    );
    const retained = new Set<string>();
    for (const [sortOrder, { id, name, url }] of items.entries()) {
      if (id !== undefined && existingIds.has(id)) {
        retained.add(id);
        await transaction.updateTable("project_repository_link")
          .set({ name, url, sort_order: sortOrder })
          .where("id", "=", id).where("project_id", "=", projectId).execute();
      } else {
        await transaction.insertInto("project_repository_link")
          .values({ id: crypto.randomUUID(), project_id: projectId, name, url, sort_order: sortOrder })
          .execute();
      }
    }
    const removed = [...existingIds].filter((id) => !retained.has(id));
    if (removed.length) {
      await transaction.deleteFrom("project_repository_link")
        .where("project_id", "=", projectId).where("id", "in", removed).execute();
    }
  }

  private async syncResources(
    transaction: Transaction<Database>,
    projectId: string,
    items: NonNullable<UpdateProjectInput["resources"]>,
  ): Promise<void> {
    const existingIds = new Set(
      (await transaction.selectFrom("project_resource").select("id")
        .where("project_id", "=", projectId).execute()).map(({ id }) => id),
    );
    const retained = new Set<string>();
    for (const [sortOrder, { id, name, url, kind }] of items.entries()) {
      if (id !== undefined && existingIds.has(id)) {
        retained.add(id);
        await transaction.updateTable("project_resource")
          .set({ name, url, kind, sort_order: sortOrder })
          .where("id", "=", id).where("project_id", "=", projectId).execute();
      } else {
        await transaction.insertInto("project_resource")
          .values({ id: crypto.randomUUID(), project_id: projectId, name, url, kind, sort_order: sortOrder })
          .execute();
      }
    }
    const removed = [...existingIds].filter((id) => !retained.has(id));
    if (removed.length) {
      await transaction.deleteFrom("project_resource")
        .where("project_id", "=", projectId).where("id", "in", removed).execute();
    }
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
