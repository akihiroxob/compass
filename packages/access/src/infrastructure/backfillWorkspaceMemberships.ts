import type { Kysely } from "kysely";
import { humanRoles, type HumanRole } from "../domain/HumanAuth.ts";
import type { AccessWorkspaceReaders } from "./AccessWorkspaceReaders.ts";
import type { AccessDatabase } from "./schema.ts";

/** `humanRoles`は強い順。 */
const stronger = (a: HumanRole, b: HumanRole): HumanRole => (humanRoles.indexOf(a) <= humanRoles.indexOf(b) ? a : b);

/**
 * Workspace導入前のDBで、Projectの有効なHuman Membershipを所属Workspaceの初期Membershipとして一度だけ写す
 * （同じHumanが複数Projectに居れば強いRole）。移行前にProject Membershipで行えたWorkspace相当の操作（Direction等）を
 * 失わないための移行で、実行時の継承ではない。以後のProject招待・Role変更はWorkspaceへ反映しない。
 * 対象はWorkspace Membershipの行（取消済みを含む）が1件も無いWorkspaceだけなので、再起動・再実行で重複しない。
 * Project memberが居ないWorkspace（orphan Project）は、platform ownerのログイン時のorphan補完で引き取る。
 */
export const backfillWorkspaceMemberships = async (
  database: Kysely<AccessDatabase>,
  workspaceReaders: AccessWorkspaceReaders,
  clock: () => number = Date.now,
): Promise<void> => {
  await database.transaction().execute(async (transaction) => {
    const workspaces = workspaceReaders(transaction);
    const now = clock();
    for (const workspaceId of await workspaces.listIdsInCreationOrder()) {
      const hasMembership = await transaction
        .selectFrom("workspace_membership")
        .select("id")
        .where("workspace_id", "=", workspaceId)
        .executeTakeFirst();
      if (hasMembership) continue;
      const projectIds = await workspaces.listProjectIds(workspaceId);
      if (projectIds.length === 0) continue;
      const rows = await transaction
        .selectFrom("project_membership")
        .select(["human_user_id", "role"])
        .where("project_id", "in", projectIds)
        .where("revoked_at", "is", null)
        .orderBy("created_at")
        .orderBy("id")
        .execute();
      const roles = new Map<string, HumanRole>();
      for (const { human_user_id, role } of rows) {
        const current = roles.get(human_user_id);
        roles.set(human_user_id, current ? stronger(current, role) : role);
      }
      for (const [humanUserId, role] of roles) {
        await transaction
          .insertInto("workspace_membership")
          .values({
            id: crypto.randomUUID(),
            workspace_id: workspaceId,
            human_user_id: humanUserId,
            role,
            created_at: now,
            updated_at: now,
            created_by_human_user_id: null,
            revoked_at: null,
            revoked_by_human_user_id: null,
          })
          .execute();
      }
    }
  });
};
