import { sql, type CompiledQuery, type Kysely } from "kysely";
import type { D1Database } from "@cloudflare/workers-types";
import {
  Workspace, type WorkspaceRepository, type WorkspaceStatus,
  type CreateWorkspaceInput, type UpdateWorkspaceInput, type UpdateWorkspaceResult, type ArchiveWorkspaceResult,
  type OrganizationDatabase,
} from "@compass/organization";
import { ConflictError } from "@compass/shared";
import { D1AtomicBatch, D1PreconditionFailedError } from "../../database/d1/D1AtomicBatch.ts";

type OrderedTextTable = "workspace_principle" | "workspace_constraint";
export type D1OwnerMembershipPlanner = (input: {
  workspaceId: string; ownerHumanUserId: string; createdAt: number;
}) => readonly CompiledQuery[];

type WorkspaceRecord = OrganizationDatabase["workspace"] & { principles_json: string; constraints_json: string };

/** SQLite版と同じWorkspace契約を、SQL前提条件付きのD1 batchで実装する。 */
export class D1WorkspaceRepository implements WorkspaceRepository {
  private readonly atomic: D1AtomicBatch;

  constructor(
    private readonly database: Kysely<OrganizationDatabase>,
    binding: D1Database,
    private readonly planOwnerMembership?: D1OwnerMembershipPlanner,
    private readonly clock: () => number = Date.now,
  ) {
    this.atomic = new D1AtomicBatch(binding);
  }

  /** Projectと専用Workspaceを同時作成するときも、このSQLを同じbatchへ組み込む。 */
  planCreate(input: CreateWorkspaceInput, ownerHumanUserId?: string) {
    const now = this.clock();
    const workspace = new Workspace({ id: crypto.randomUUID(), ...input,
      createdAt: now, updatedAt: now, status: "active", archivedAt: null, archiveReason: null });
    const mutations: CompiledQuery[] = [this.database.insertInto("workspace").values({
      id: workspace.id, name: workspace.name, mission: workspace.mission, vision: workspace.vision,
      created_at: now, updated_at: now, status: "active", archived_at: null, archive_reason: null,
    }).compile()];
    mutations.push(...this.orderedInserts("workspace_principle", workspace.id, workspace.principles));
    mutations.push(...this.orderedInserts("workspace_constraint", workspace.id, workspace.constraints));
    if (ownerHumanUserId !== undefined) {
      if (!this.planOwnerMembership) throw new Error("D1OwnerMembershipPlanner is not configured");
      mutations.push(...this.planOwnerMembership({ workspaceId: workspace.id, ownerHumanUserId, createdAt: now }));
    }
    return { workspace, mutations };
  }

  async create(input: CreateWorkspaceInput, ownerHumanUserId?: string): Promise<Workspace> {
    const { workspace, mutations } = this.planCreate(input, ownerHumanUserId);
    await this.atomic.execute([], mutations);
    return workspace;
  }

  async update(workspaceId: string, input: UpdateWorkspaceInput): Promise<UpdateWorkspaceResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.findById(workspaceId);
      if (!existing) return { kind: "not_found" };
      if (existing.status === "archived") return { kind: "workspace_archived" };
      if (input.expectedUpdatedAt !== undefined && input.expectedUpdatedAt !== existing.updatedAt) return { kind: "stale" };
      const updatedAt = Math.max(this.clock(), existing.updatedAt + 1);
      const mutations: CompiledQuery[] = [this.database.updateTable("workspace").set({
        name: input.name, mission: input.mission, vision: input.vision, updated_at: updatedAt,
      }).where("id", "=", workspaceId).compile()];
      for (const [table, values] of [["workspace_principle", input.principles], ["workspace_constraint", input.constraints]] as const) {
        if (values === undefined) continue;
        mutations.push(this.database.deleteFrom(table).where("workspace_id", "=", workspaceId).compile());
        mutations.push(...this.orderedInserts(table, workspaceId, values));
      }
      try {
        await this.atomic.execute([this.currentVersion(existing)], mutations);
        return { kind: "updated", workspace: new Workspace({
          ...existing, name: input.name ?? existing.name, mission: input.mission ?? existing.mission,
          vision: input.vision === undefined ? existing.vision : input.vision,
          principles: input.principles ?? existing.principles, constraints: input.constraints ?? existing.constraints, updatedAt,
        }) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
        // 前提不成立だけを再読取する。通信断・SQLエラーを再送しない。
      }
    }
    throw new ConflictError("Workspace changed repeatedly during the update", { workspaceId });
  }

  async archive(workspaceId: string, reason: string): Promise<ArchiveWorkspaceResult> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const existing = await this.findById(workspaceId);
      if (!existing) return { kind: "not_found" };
      if (existing.status === "archived") return { kind: "already_archived" };
      const now = this.clock();
      try {
        await this.atomic.execute([this.currentVersion(existing)], [this.database.updateTable("workspace").set({
          status: "archived", archived_at: now, archive_reason: reason, updated_at: now,
        }).where("id", "=", workspaceId).compile()]);
        return { kind: "archived", workspace: new Workspace({ ...existing, status: "archived", archivedAt: now, archiveReason: reason, updatedAt: now }) };
      } catch (error) {
        if (!(error instanceof D1PreconditionFailedError)) throw error;
      }
    }
    throw new ConflictError("Workspace changed repeatedly during archive", { workspaceId });
  }

  async findAll(status: WorkspaceStatus = "active"): Promise<Workspace[]> {
    return (await this.records().where("workspace.status", "=", status).execute()).map((row) => this.hydrate(row));
  }

  async findById(workspaceId: string): Promise<Workspace | null> {
    const row = await this.records().where("workspace.id", "=", workspaceId).executeTakeFirst();
    return row ? this.hydrate(row) : null;
  }

  private currentVersion(workspace: Workspace) {
    return this.database.selectFrom("workspace").select("id").where("id", "=", workspace.id)
      .where("status", "=", "active").where("updated_at", "=", workspace.updatedAt).compile();
  }

  private orderedInserts(table: OrderedTextTable, workspaceId: string, values: readonly string[]): CompiledQuery[] {
    if (values.length === 0) return [];
    return [this.database.insertInto(table).values(values.map((value, sortOrder) => ({
      id: crypto.randomUUID(), workspace_id: workspaceId, value, sort_order: sortOrder,
    }))).compile()];
  }

  private records() {
    // 子要素も同じSQLで読むため、同時更新時に親の版と子要素の版が混ざらない。
    return this.database.selectFrom("workspace").selectAll().select([
      sql<string>`(select json_group_array(value) from (select value from workspace_principle where workspace_id = workspace.id order by sort_order))`.as("principles_json"),
      sql<string>`(select json_group_array(value) from (select value from workspace_constraint where workspace_id = workspace.id order by sort_order))`.as("constraints_json"),
    ]);
  }

  private hydrate(row: WorkspaceRecord): Workspace {
    return new Workspace({ id: row.id, name: row.name, mission: row.mission, vision: row.vision,
      principles: JSON.parse(row.principles_json) as string[], constraints: JSON.parse(row.constraints_json) as string[],
      createdAt: row.created_at, updatedAt: row.updated_at, status: row.status, archivedAt: row.archived_at, archiveReason: row.archive_reason });
  }
}
