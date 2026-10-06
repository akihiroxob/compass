import { sql, type Kysely, type Transaction } from "kysely";
import { SQLiteProjectRepository, type DirectionDatabase, type ProjectWorkspaceAssigner } from "@compass/direction";
import { writeWorkspace } from "@compass/organization";
import { asDirectionDatabase, asOrganizationTransaction } from "../../bootstrap/database/contextDatabase.ts";
import type { Database } from "../../bootstrap/database/schema.ts";

/**
 * Projectの所属Workspace（`project.workspace_id`）。`project`はDirectionが所有するが、所属はWorkspaceとProjectを
 * 合成するserverが書く。ProjectのOrganizationへの移設（S02-03）までの配線（docs/workspace-migration-impact-map.md）。
 */
type ProjectWorkspaceDatabase = { project: { id: string; created_at: number; workspace_id: string | null } };

const asProjectWorkspaceDatabase = (database: Kysely<DirectionDatabase>) =>
  database as unknown as Kysely<ProjectWorkspaceDatabase>;

/**
 * 既存DBの`project`へnullableの`workspace_id`（FK `workspace.id`）を、列が無い場合だけ加える（idempotent）。
 * 既存の列・行は変えないため、追加後のDBを導入前のserverで起動してもProjectを読み書きできる。
 */
export const addProjectWorkspaceColumn = async (database: Kysely<Database>): Promise<void> => {
  const columns = await sql<{ name: string }>`select name from pragma_table_info('project')`.execute(database);
  if (columns.rows.some(({ name }) => name === "workspace_id")) return;
  await sql`alter table project add column workspace_id text references workspace(id)`.execute(database);
};

/**
 * 未所属のProjectに、その戦略値（name・Mission・Vision・Principles・Constraints）を写したWorkspaceを作って所属させる。
 * statusとarchive列・作成/更新時刻もProjectに合わせ、archive済みProjectのWorkspaceはarchivedにする。
 * 渡されたtransactionで行い、所属済み（同時に割り当てられた場合を含む）なら失敗させて全体を戻す。
 */
const assignProjectWorkspace = async (transaction: Transaction<DirectionDatabase>, projectId: string): Promise<void> => {
  const project = await new SQLiteProjectRepository(transaction).findById(projectId);
  if (!project) throw new Error(`Project ${projectId} not found`);

  const workspaceId = crypto.randomUUID();
  await writeWorkspace(asOrganizationTransaction(transaction), {
    id: workspaceId,
    name: project.name,
    mission: project.mission,
    vision: project.vision,
    principles: project.principles,
    constraints: project.constraints,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    status: project.status,
    archivedAt: project.archivedAt,
    archiveReason: project.archiveReason,
  });
  const result = await asProjectWorkspaceDatabase(transaction)
    .updateTable("project")
    .set({ workspace_id: workspaceId })
    .where("id", "=", projectId)
    .where("workspace_id", "is", null)
    .executeTakeFirst();
  if (result.numUpdatedRows !== 1n) throw new Error(`Project ${projectId} already belongs to a Workspace`);
};

/** DirectionのProject作成のtransactionで、作成したProjectを専用のWorkspaceへ所属させる。 */
export const projectWorkspaceAssigner: ProjectWorkspaceAssigner = (transaction, { projectId }) =>
  assignProjectWorkspace(transaction, projectId);

/**
 * 既存Projectごとに1つのWorkspaceを作り所属させる（非破壊の移行）。Project 1件ごとのtransactionで行い、
 * 対象を「`workspace_id`がnull」とするため、再起動・再実行・途中失敗後の再実行でもWorkspaceを重複して作らない。
 * Project ID・Story / Task・Grant・Credential・Change Log・Activity等の既存行は書き換えない。
 */
export const assignWorkspacesToUnassignedProjects = async (database: Kysely<Database>): Promise<void> => {
  const direction = asDirectionDatabase(database);
  const projects = await asProjectWorkspaceDatabase(direction)
    .selectFrom("project")
    .select("id")
    .where("workspace_id", "is", null)
    .orderBy("created_at")
    .orderBy("id")
    .execute();
  for (const { id } of projects) {
    await direction.transaction().execute((transaction) => assignProjectWorkspace(transaction, id));
  }
};
