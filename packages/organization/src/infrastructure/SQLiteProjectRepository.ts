import type { Kysely, Transaction } from "kysely";
import { Project, type ProjectDetail, type ProjectStatus } from "../domain/Project.ts";
import type {
  ArchiveProjectResult,
  CreateProjectInput,
  CreateWorkspaceProjectInput,
  CreateWorkspaceProjectResult,
  ProjectRepository,
  RepositoryReferencedResult,
  UpdateProjectInput,
  UpdateProjectResult,
} from "../domain/ProjectRepository.ts";
import type { ProjectChangeObserver } from "./projectChange.ts";
import type { OrganizationDatabase } from "./schema.ts";
import type { WorkspaceOwnerMembershipWriter } from "./SQLiteWorkspaceRepository.ts";
import { replaceWorkspaceOrderedValues, writeWorkspace } from "./writeWorkspace.ts";

type Queryable = Kysely<OrganizationDatabase> | Transaction<OrganizationDatabase>;

/**
 * 作成者の初期owner Membership（Accessが所有するtable）を、Project作成と同じtransactionで書く。
 * OrganizationはAccessのtableを直接扱わず、serverがこの書込を配線する。失敗すればProjectもrollbackされる。
 */
export type ProjectOwnerMembershipWriter = (
  transaction: Transaction<OrganizationDatabase>,
  input: { projectId: string; ownerHumanUserId: string; createdAt: number },
) => Promise<void>;

/** 作成者の初期owner Membership（Project・同時に作るWorkspace）の書込。serverがAccessの実装を配線する。 */
export type OwnerMembershipWriters = {
  project: ProjectOwnerMembershipWriter;
  workspace: WorkspaceOwnerMembershipWriter;
};

/**
 * 指定したRepositoryのうち、ADR Handoff Request/Reference（Directionが所有するtable）から参照されているものがあれば
 * そのIDを1件返す。OrganizationはDirectionのtableを直接扱わず、serverが同じtransactionで読む実装を配線する。
 */
export type ProjectRepositoryReferenceFinder = (
  transaction: Transaction<OrganizationDatabase>,
  repositoryIds: string[],
) => Promise<string | null>;

/** 旧`project.mission`はNOT NULLのため作成時に書く値。戦略値の正本はWorkspaceで、旧列は読まない。 */
const unusedLegacyMission = "";

export class SQLiteProjectRepository implements ProjectRepository {
  constructor(
    private readonly database: Kysely<OrganizationDatabase>,
    private readonly findRepositoryReference: ProjectRepositoryReferenceFinder,
    private readonly ownerMembershipWriters?: OwnerMembershipWriters,
    private readonly changeObserver: ProjectChangeObserver | null = null,
  ) {}

  async create(input: CreateProjectInput, ownerHumanUserId?: string): Promise<ProjectDetail> {
    const id = crypto.randomUUID();
    const workspaceId = crypto.randomUUID();
    const now = Date.now();

    await this.database.transaction().execute(async (transaction) => {
      // 既存の公開入口（Mission等を含むProject作成）は、Projectごとに戦略値を持つ専用のWorkspaceを作る。
      await writeWorkspace(transaction, {
        id: workspaceId,
        name: input.name,
        mission: input.mission,
        vision: input.vision,
        principles: input.principles,
        constraints: input.constraints,
        createdAt: now,
        updatedAt: now,
        status: "active",
        archivedAt: null,
        archiveReason: null,
      });
      await this.insertProject(transaction, { id, workspaceId, input, now });
      if (ownerHumanUserId !== undefined) {
        // 作成者は同時に作ったWorkspaceのownerにもなる。既存Workspaceへの作成（createInWorkspace）では書かない。
        await this.requireOwnerMembershipWriters().workspace(transaction, { workspaceId, ownerHumanUserId, createdAt: now });
        await this.requireOwnerMembershipWriters().project(transaction, { projectId: id, ownerHumanUserId, createdAt: now });
      }
    });

    return (await this.findDetailById(id))!;
  }

  async createInWorkspace(
    workspaceId: string,
    input: CreateWorkspaceProjectInput,
    ownerHumanUserId?: string,
  ): Promise<CreateWorkspaceProjectResult> {
    const id = crypto.randomUUID();
    const now = Date.now();

    const outcome = await this.database.transaction().execute(async (transaction) => {
      // 書込と同じtransactionで検査し、確認と書込の間に入ったWorkspaceのarchiveを見逃さない。
      const workspace = await transaction
        .selectFrom("workspace")
        .select("status")
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (!workspace) return "not_found" as const;
      if (workspace.status === "archived") return "workspace_archived" as const;

      await this.insertProject(transaction, { id, workspaceId, input, now });
      if (ownerHumanUserId !== undefined) {
        await this.requireOwnerMembershipWriters().project(transaction, { projectId: id, ownerHumanUserId, createdAt: now });
      }
      return "created" as const;
    });

    if (outcome !== "created") return { kind: outcome };
    return { kind: "created", project: (await this.findDetailById(id))! };
  }

  async update(projectId: string, input: UpdateProjectInput): Promise<UpdateProjectResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("project")
        .innerJoin("workspace", "workspace.id", "project.workspace_id")
        .select(["project.status as status", "workspace.id as workspaceId", "workspace.status as workspaceStatus"])
        .where("project.id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return { kind: "not_found" as const };
      if (existing.status === "archived") return { kind: "project_archived" as const };
      const updatesStrategy = [input.mission, input.vision, input.principles, input.constraints].some(
        (value) => value !== undefined,
      );
      if (updatesStrategy && existing.workspaceStatus === "archived") {
        return { kind: "workspace_archived" as const, workspaceId: existing.workspaceId };
      }

      // Repositoryを外す変更はADR Handoff Request/Referenceの参照先を失わせないか、他の書込より先に検査する。
      // 途中まで書き込んでから拒否すると、そのtransactionはKyselyの仕様上そのまま commit されてしまうため。
      if (input.repositories) {
        const conflict = await this.findRepositoryRemovalConflict(transaction, projectId, input.repositories);
        if (conflict) return conflict;
      }

      // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
      // 戦略値だけの変更でもProjectのupdated_atを進める（一覧の更新順は従来どおりProject単位）。
      const now = Date.now();
      await transaction
        .updateTable("project")
        .set({ name: input.name, description: input.description, updated_at: now })
        .where("id", "=", projectId)
        .execute();

      if (updatesStrategy) {
        await transaction
          .updateTable("workspace")
          .set({ mission: input.mission, vision: input.vision, updated_at: now })
          .where("id", "=", existing.workspaceId)
          .execute();
        if (input.principles) {
          await replaceWorkspaceOrderedValues(transaction, "workspace_principle", existing.workspaceId, input.principles);
        }
        if (input.constraints) {
          await replaceWorkspaceOrderedValues(transaction, "workspace_constraint", existing.workspaceId, input.constraints);
        }
      }
      if (input.repositories) await this.syncRepositories(transaction, projectId, input.repositories);
      if (input.resources) await this.syncResources(transaction, projectId, input.resources);
      return { kind: "updated" as const };
    });

    if (outcome.kind !== "updated") return outcome;
    return { kind: "updated", project: (await this.findDetailById(projectId))! };
  }

  async archive(projectId: string, reason: string): Promise<ArchiveProjectResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("project")
        .select(["status", "name", "workspace_id"])
        .where("id", "=", projectId)
        .executeTakeFirst();
      if (!existing) return "not_found" as const;
      if (existing.status === "archived") return "already_archived" as const;
      const workspaceId = existing.workspace_id;
      if (workspaceId === null) throw new Error(`Project ${projectId} does not belong to a Workspace`);

      // updated_atはarchived_atと同じ値にする（Intentの放棄・Outcomeの取消がupdated_atを更新するのと同じ）。
      const now = Date.now();
      const archived = { status: "archived" as const, archived_at: now, archive_reason: reason, updated_at: now };
      await transaction.updateTable("project").set(archived).where("id", "=", projectId).execute();
      // 他にactiveなProjectが無いWorkspaceは、新規活動を受けないよう同じ理由・日時でarchiveする（移行時の規則と同じ）。
      const activeProject = await transaction
        .selectFrom("project")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .where("status", "=", "active")
        .executeTakeFirst();
      if (!activeProject) {
        await transaction
          .updateTable("workspace")
          .set(archived)
          .where("id", "=", workspaceId)
          .where("status", "=", "active")
          .execute();
      }
      if (this.changeObserver) {
        await this.changeObserver(transaction)({
          type: "project_archived",
          projectId,
          workspaceId,
          title: existing.name,
          reason,
          occurredAt: now,
        });
      }
      return "archived" as const;
    });

    if (outcome !== "archived") return { kind: outcome };
    return { kind: "archived", project: (await this.findDetailById(projectId))! };
  }

  async findAll(status: ProjectStatus = "active"): Promise<ProjectDetail[]> {
    const rows = await this.database
      .selectFrom("project")
      .select("id")
      .where("status", "=", status)
      .execute();
    return Promise.all(rows.map(async ({ id }) => (await this.findDetailById(id))!));
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
    if (row.workspace_id === null) throw new Error(`Project ${projectId} does not belong to a Workspace`);

    const [repositories, resources] = await Promise.all([
      this.database.selectFrom("project_repository_link").select(["id", "name", "url"])
        .where("project_id", "=", projectId).orderBy("sort_order").execute(),
      this.database.selectFrom("project_resource").select(["id", "name", "url", "kind"])
        .where("project_id", "=", projectId).orderBy("sort_order").execute(),
    ]);

    return new Project({
      id: row.id,
      workspaceId: row.workspace_id,
      name: row.name,
      description: row.description,
      repositories,
      resources,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      archivedAt: row.archived_at,
      archiveReason: row.archive_reason,
    });
  }

  async findDetailById(projectId: string): Promise<ProjectDetail | null> {
    const project = await this.findById(projectId);
    if (!project) return null;
    const workspace = await this.database
      .selectFrom("workspace")
      .select(["mission", "vision"])
      .where("id", "=", project.workspaceId)
      .executeTakeFirstOrThrow();
    const [principles, constraints] = await Promise.all([
      this.orderedValues(this.database, "workspace_principle", project.workspaceId),
      this.orderedValues(this.database, "workspace_constraint", project.workspaceId),
    ]);
    // 既存の公開契約と同じ項目・順序にする（所属Workspace IDは含めない）。
    return {
      id: project.id,
      name: project.name,
      description: project.description,
      mission: workspace.mission,
      vision: workspace.vision,
      principles,
      constraints,
      repositories: project.repositories,
      resources: project.resources,
      createdAt: project.createdAt,
      updatedAt: project.updatedAt,
      status: project.status,
      archivedAt: project.archivedAt,
      archiveReason: project.archiveReason,
    };
  }

  /**
   * 入力から外れる既存Repositoryのうち、ADR Handoff Request/Reference（Direction）から参照されている行が
   * あれば最初の1件を返す。`adr_handoff_request` / `adr_reference` の`repository_id`はonDelete cascadeを
   * 付けていない意図的な監査保持のため、削除前にdomainの`repository_referenced`として検査し拒否する。
   */
  private requireOwnerMembershipWriters(): OwnerMembershipWriters {
    if (!this.ownerMembershipWriters) throw new Error("OwnerMembershipWriters is not configured");
    return this.ownerMembershipWriters;
  }

  /** Project行とRepository / Resourceを書く。所属Workspaceの作成・検査は呼出し側が同じtransactionで行う。 */
  private async insertProject(
    transaction: Transaction<OrganizationDatabase>,
    { id, workspaceId, input, now }: { id: string; workspaceId: string; input: CreateWorkspaceProjectInput; now: number },
  ): Promise<void> {
    await transaction
      .insertInto("project")
      .values({
        id,
        workspace_id: workspaceId,
        name: input.name,
        description: input.description,
        mission: unusedLegacyMission,
        vision: null,
        created_at: now,
        updated_at: now,
        status: "active",
        archived_at: null,
        archive_reason: null,
        strategy_migrated_at: now,
      })
      .execute();

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
  }

  private async findRepositoryRemovalConflict(
    transaction: Transaction<OrganizationDatabase>,
    projectId: string,
    items: NonNullable<UpdateProjectInput["repositories"]>,
  ): Promise<RepositoryReferencedResult | null> {
    const existingRows = await transaction.selectFrom("project_repository_link").select(["id", "name"])
      .where("project_id", "=", projectId).execute();
    const keptIds = new Set(items.flatMap(({ id }) => (id !== undefined ? [id] : [])));
    const removed = existingRows.filter((row) => !keptIds.has(row.id));
    if (!removed.length) return null;

    const repositoryId = await this.findRepositoryReference(transaction, removed.map((row) => row.id));
    if (!repositoryId) return null;

    const repositoryName = removed.find((row) => row.id === repositoryId)?.name ?? repositoryId;
    return { kind: "repository_referenced", repositoryId, repositoryName };
  }

  /**
   * 入力のidがこのProjectの既存行と一致する場合だけ、その行を更新してidを維持する。
   * idなし・未知のid・他Projectのidは新規行として追加し、入力に現れない既存行は削除する。
   */
  private async syncRepositories(
    transaction: Transaction<OrganizationDatabase>,
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
    transaction: Transaction<OrganizationDatabase>,
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
    table: "workspace_principle" | "workspace_constraint",
    workspaceId: string,
  ): Promise<string[]> {
    const rows = await database.selectFrom(table).select("value")
      .where("workspace_id", "=", workspaceId).orderBy("sort_order").execute();
    return rows.map(({ value }) => value);
  }
}
