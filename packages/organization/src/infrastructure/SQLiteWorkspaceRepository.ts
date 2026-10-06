import type { Kysely, Transaction } from "kysely";
import { Workspace, type WorkspaceStatus } from "../domain/Workspace.ts";
import type {
  ArchiveWorkspaceResult,
  CreateWorkspaceInput,
  UpdateWorkspaceInput,
  UpdateWorkspaceResult,
  WorkspaceRepository,
} from "../domain/WorkspaceRepository.ts";
import type { OrganizationDatabase } from "./schema.ts";
import { writeWorkspace } from "./writeWorkspace.ts";

type OrderedTextTable = "workspace_principle" | "workspace_constraint";

export class SQLiteWorkspaceRepository implements WorkspaceRepository {
  constructor(private readonly database: Kysely<OrganizationDatabase>) {}

  async create(input: CreateWorkspaceInput): Promise<Workspace> {
    const id = crypto.randomUUID();
    const now = Date.now();

    await this.database.transaction().execute((transaction) =>
      writeWorkspace(transaction, {
        id,
        ...input,
        createdAt: now,
        updatedAt: now,
        status: "active",
        archivedAt: null,
        archiveReason: null,
      }),
    );

    return (await this.findById(id))!;
  }

  async update(workspaceId: string, input: UpdateWorkspaceInput): Promise<UpdateWorkspaceResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("workspace")
        .select("status")
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (!existing) return "not_found" as const;
      if (existing.status === "archived") return "workspace_archived" as const;

      // undefinedの項目はKyselyがSETから除外するため、未指定の列は変更されない。
      await transaction
        .updateTable("workspace")
        .set({ name: input.name, mission: input.mission, vision: input.vision, updated_at: Date.now() })
        .where("id", "=", workspaceId)
        .execute();
      if (input.principles) {
        await this.replaceOrderedValues(transaction, "workspace_principle", workspaceId, input.principles);
      }
      if (input.constraints) {
        await this.replaceOrderedValues(transaction, "workspace_constraint", workspaceId, input.constraints);
      }
      return "updated" as const;
    });

    if (outcome !== "updated") return { kind: outcome };
    return { kind: "updated", workspace: (await this.findById(workspaceId))! };
  }

  async archive(workspaceId: string, reason: string): Promise<ArchiveWorkspaceResult> {
    const outcome = await this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("workspace")
        .select("status")
        .where("id", "=", workspaceId)
        .executeTakeFirst();
      if (!existing) return "not_found" as const;
      if (existing.status === "archived") return "already_archived" as const;

      // updated_atはarchived_atと同じ値にする（Projectのarchiveと同じ）。
      const now = Date.now();
      await transaction
        .updateTable("workspace")
        .set({ status: "archived", archived_at: now, archive_reason: reason, updated_at: now })
        .where("id", "=", workspaceId)
        .execute();
      return "archived" as const;
    });

    if (outcome !== "archived") return { kind: outcome };
    return { kind: "archived", workspace: (await this.findById(workspaceId))! };
  }

  async findAll(status: WorkspaceStatus = "active"): Promise<Workspace[]> {
    const rows = await this.database.selectFrom("workspace").select("id").where("status", "=", status).execute();
    return Promise.all(rows.map(async ({ id }) => (await this.findById(id))!));
  }

  async findById(workspaceId: string): Promise<Workspace | null> {
    const row = await this.database
      .selectFrom("workspace")
      .selectAll()
      .where("id", "=", workspaceId)
      .executeTakeFirst();
    if (!row) return null;

    const [principles, constraints] = await Promise.all([
      this.orderedValues("workspace_principle", workspaceId),
      this.orderedValues("workspace_constraint", workspaceId),
    ]);

    return new Workspace({
      id: row.id,
      name: row.name,
      mission: row.mission,
      vision: row.vision,
      principles,
      constraints,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      status: row.status,
      archivedAt: row.archived_at,
      archiveReason: row.archive_reason,
    });
  }

  private async replaceOrderedValues(
    transaction: Transaction<OrganizationDatabase>,
    table: OrderedTextTable,
    workspaceId: string,
    values: string[],
  ): Promise<void> {
    await transaction.deleteFrom(table).where("workspace_id", "=", workspaceId).execute();
    if (!values.length) return;
    await transaction.insertInto(table).values(
      values.map((value, sortOrder) => ({
        id: crypto.randomUUID(), workspace_id: workspaceId, value, sort_order: sortOrder,
      })),
    ).execute();
  }

  private async orderedValues(table: OrderedTextTable, workspaceId: string): Promise<string[]> {
    const rows = await this.database.selectFrom(table).select("value")
      .where("workspace_id", "=", workspaceId).orderBy("sort_order").execute();
    return rows.map(({ value }) => value);
  }
}
