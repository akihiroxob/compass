import { sql, type CompiledQuery, type Kysely } from "kysely";
import type { D1Database } from "@cloudflare/workers-types";
import {
  Project, type ProjectDetail, type ProjectStatus, type ProjectRepository, type ProjectRepositoryLink, type ProjectResource,
  type OrganizationDatabase, type ProjectChangeNotice, type CreateProjectInput, type CreateWorkspaceProjectInput,
  type CreateWorkspaceProjectResult, type UpdateProjectInput, type UpdateProjectResult, type ArchiveProjectResult,
} from "@compass/organization";
import { ConflictError } from "@compass/shared";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";
import type { D1WorkspaceRepository } from "./D1WorkspaceRepository.ts";

type ProjectRecord = OrganizationDatabase["project"] & { repositories_json: string; resources_json: string };
type DetailRecord = ProjectRecord & { mission: string; vision: string | null; principles_json: string; constraints_json: string };
export type D1ProjectReferenceChecks = {
  findReferenced(repositoryIds: string[]): Promise<string | null>;
  notReferenced(repositoryIds: string[]): CompiledQuery;
};
export type D1ProjectArchivePlanner = (notice: ProjectChangeNotice) => CompiledQuery;

/** Projectと関連書込みを原子的に保存するD1実装。Context間の変更はSQL計画を同じbatchへ渡す。 */
export class D1ProjectRepository implements ProjectRepository {
  private readonly atomic: D1AtomicBatch;

  constructor(
    private readonly database: Kysely<OrganizationDatabase>,
    binding: D1Database,
    private readonly workspaces: Pick<D1WorkspaceRepository, "planCreate">,
    private readonly references: D1ProjectReferenceChecks,
    private readonly planArchive: D1ProjectArchivePlanner,
    private readonly clock: () => number = Date.now,
  ) {
    this.atomic = new D1AtomicBatch(binding);
  }

  async create(input: CreateProjectInput, ownerHumanUserId?: string): Promise<ProjectDetail> {
    const { workspace, mutations } = this.workspaces.planCreate(input, ownerHumanUserId);
    const id = crypto.randomUUID();
    await this.atomic.execute([], [...mutations, ...this.planInsert(id, workspace.id, input, workspace.createdAt)]);
    return this.requireDetail(id);
  }

  async createInWorkspace(workspaceId: string, input: CreateWorkspaceProjectInput): Promise<CreateWorkspaceProjectResult> {
    const id = crypto.randomUUID();
    const active = this.database.selectFrom("workspace").select("id").where("id", "=", workspaceId).where("status", "=", "active");
    try {
      await this.atomic.execute([active.compile()], this.planInsert(id, workspaceId, input, this.clock()));
    } catch (error) {
      if (!(error instanceof D1PreconditionFailedError)) throw error;
      const workspace = await this.database.selectFrom("workspace").select("status").where("id", "=", workspaceId).executeTakeFirst();
      if (!workspace) return { kind: "not_found" };
      if (workspace.status === "archived") return { kind: "workspace_archived" };
      throw new ConflictError("Workspace changed while creating the Project", { workspaceId });
    }
    return { kind: "created", project: await this.requireDetail(id) };
  }

  async update(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const project = await this.findById(projectId);
      if (!project) return { kind: "not_found" };
      if (project.status === "archived") return { kind: "project_archived" };
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== project.updatedAt) return { kind: "stale" };
      const guards = [this.currentVersion(project)];
      const mutations: CompiledQuery[] = [this.database.updateTable("project").set({ name: input.name,
        description: input.description, updated_at: Math.max(this.clock(), project.updatedAt + 1),
      }).where("id", "=", projectId).compile()];
      if (input.repositories) {
        const kept = new Set(input.repositories.map(({ id }) => id));
        const removed = project.repositories.filter(({ id }) => !kept.has(id));
        if (removed.length) {
          const ids = removed.map(({ id }) => id);
          const referenced = await this.references.findReferenced(ids);
          if (referenced) return { kind: "repository_referenced", repositoryId: referenced,
            repositoryName: removed.find(({ id }) => id === referenced)?.name ?? referenced };
          // ADR参照の追加はProjectの版を変えないため、版の検査とは別にcommit時も照合する。
          guards.push(this.references.notReferenced(ids));
          mutations.push(this.database.deleteFrom("project_repository_link").where("project_id", "=", projectId).where("id", "in", ids).compile());
        }
        mutations.push(...this.planRepositories(project, input.repositories));
      }
      if (input.resources) mutations.push(...this.planResources(project, input.resources));
      try {
        await this.atomic.execute(guards, mutations);
        return { kind: "updated", project: await this.requireDetail(projectId) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Project changed repeatedly during the update", { projectId });
  }

  async archive(projectId: string, reason: string): Promise<ArchiveProjectResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const project = await this.findById(projectId);
      if (!project) return { kind: "not_found" };
      if (project.status === "archived") return { kind: "already_archived" };
      const now = this.clock();
      try {
        await this.atomic.execute([this.currentVersion(project)], [
          this.database.updateTable("project").set({ status: "archived", archived_at: now, archive_reason: reason, updated_at: now })
            .where("id", "=", projectId).compile(),
          this.planArchive({ type: "project_archived", projectId, workspaceId: project.workspaceId, title: project.name, reason, occurredAt: now }),
        ]);
        return { kind: "archived", project: await this.requireDetail(projectId) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Project changed repeatedly during archive", { projectId });
  }

  async findAll(status: ProjectStatus = "active"): Promise<ProjectDetail[]> {
    return (await this.detailRecords().where("project.status", "=", status).execute()).map((row) => this.detail(row));
  }

  async findAllInWorkspace(workspaceId: string, status: ProjectStatus = "active"): Promise<Project[]> {
    return (await this.records().where("project.workspace_id", "=", workspaceId).where("project.status", "=", status).execute()).map((row) => this.hydrate(row));
  }

  async findById(id: string): Promise<Project | null> {
    const row = await this.records().where("project.id", "=", id).executeTakeFirst();
    return row ? this.hydrate(row) : null;
  }

  async findDetailById(id: string): Promise<ProjectDetail | null> {
    const row = await this.detailRecords().where("project.id", "=", id).executeTakeFirst();
    return row ? this.detail(row) : null;
  }

  async exists(id: string): Promise<boolean> {
    return (await this.database.selectFrom("project").select("id").where("id", "=", id).executeTakeFirst()) !== undefined;
  }

  private async requireDetail(id: string): Promise<ProjectDetail> {
    const project = await this.findDetailById(id);
    if (!project) throw new Error("Project not found after successful D1 batch");
    return project;
  }

  private currentVersion(project: Project) {
    return this.database.selectFrom("project").select("id").where("id", "=", project.id)
      .where("status", "=", "active").where("updated_at", "=", project.updatedAt).compile();
  }

  private planInsert(id: string, workspaceId: string, input: CreateWorkspaceProjectInput, now: number): CompiledQuery[] {
    const project = new Project({ id, workspaceId, name: input.name, description: input.description,
      repositories: [], resources: [], createdAt: now, updatedAt: now, status: "active", archivedAt: null, archiveReason: null });
    return [this.database.insertInto("project").values({ id, workspace_id: workspaceId, name: input.name, description: input.description,
      created_at: now, updated_at: now, status: "active", archived_at: null, archive_reason: null }).compile(),
      ...this.planRepositories(project, input.repositories), ...this.planResources(project, input.resources)];
  }

  private planRepositories(project: Project, items: NonNullable<UpdateProjectInput["repositories"]>): CompiledQuery[] {
    const existing = new Map(project.repositories.map((item) => [item.id, item]));
    return items.map(({ id, name, url, requiredChecks }, sortOrder) => {
      const row = { name, url, sort_order: sortOrder, required_checks: JSON.stringify(requiredChecks ?? (id ? existing.get(id)?.requiredChecks : undefined) ?? []) };
      if (id && existing.has(id)) return this.database.updateTable("project_repository_link").set(row)
        .where("id", "=", id).where("project_id", "=", project.id).compile();
      return this.database.insertInto("project_repository_link").values({ id: crypto.randomUUID(), project_id: project.id, ...row }).compile();
    });
  }

  private planResources(project: Project, items: NonNullable<UpdateProjectInput["resources"]>): CompiledQuery[] {
    const existing = new Set(project.resources.map(({ id }) => id));
    const kept = new Set(items.map(({ id }) => id));
    const removed = [...existing].filter((id) => !kept.has(id));
    const statements: CompiledQuery[] = removed.length ? [this.database.deleteFrom("project_resource")
      .where("project_id", "=", project.id).where("id", "in", removed).compile()] : [];
    for (const [sortOrder, { id, ...item }] of items.entries()) {
      const row = { ...item, sort_order: sortOrder };
      statements.push(id && existing.has(id)
        ? this.database.updateTable("project_resource").set(row).where("id", "=", id).where("project_id", "=", project.id).compile()
        : this.database.insertInto("project_resource").values({ id: crypto.randomUUID(), project_id: project.id, ...row }).compile());
    }
    return statements;
  }

  private records() {
    return this.database.selectFrom("project").selectAll("project").select([
      sql<string>`(select json_group_array(json_object('id', id, 'name', name, 'url', url, 'requiredChecks', json(required_checks))) from (select id, name, url, required_checks from project_repository_link where project_id = project.id order by sort_order))`.as("repositories_json"),
      sql<string>`(select json_group_array(json_object('id', id, 'name', name, 'url', url, 'kind', kind)) from (select id, name, url, kind from project_resource where project_id = project.id order by sort_order))`.as("resources_json"),
    ]);
  }

  private detailRecords() {
    return this.records().innerJoin("workspace", "workspace.id", "project.workspace_id").select([
      "workspace.mission", "workspace.vision",
      sql<string>`(select json_group_array(value) from (select value from workspace_principle where workspace_id = workspace.id order by sort_order))`.as("principles_json"),
      sql<string>`(select json_group_array(value) from (select value from workspace_constraint where workspace_id = workspace.id order by sort_order))`.as("constraints_json"),
    ]);
  }

  private hydrate(row: ProjectRecord): Project {
    return new Project({ id: row.id, workspaceId: row.workspace_id, name: row.name, description: row.description,
      repositories: JSON.parse(row.repositories_json) as ProjectRepositoryLink[], resources: JSON.parse(row.resources_json) as ProjectResource[],
      createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, archivedAt: row.archived_at, archiveReason: row.archive_reason });
  }

  private detail(row: DetailRecord): ProjectDetail {
    return { ...this.hydrate(row), mission: row.mission, vision: row.vision,
      principles: JSON.parse(row.principles_json) as string[], constraints: JSON.parse(row.constraints_json) as string[] };
  }
}
