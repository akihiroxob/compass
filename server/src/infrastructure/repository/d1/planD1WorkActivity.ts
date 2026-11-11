import { canonicalWorkActivity, insertActivityQuery } from "@compass/activity";
import { asActivityDatabase, asOrganizationDatabase } from "../../database/contextDatabase.ts";
import type { D1WorkChangePlanner } from "./D1WorkStore.ts";

export const planD1WorkActivity: D1WorkChangePlanner = async (database, notice) => {
  if (!notice.subject) return [];
  const project = await asOrganizationDatabase(database).selectFrom("project").select("workspace_id").where("id", "=", notice.project_id).executeTakeFirstOrThrow();
  const activity = canonicalWorkActivity({ cursor: notice.cursor, workspaceId: project.workspace_id, projectId: notice.project_id,
    type: notice.type, principalId: notice.principal_id, payload: JSON.parse(notice.payload) as Record<string, unknown>, occurredAt: notice.occurred_at, subject: notice.subject });
  return activity ? [insertActivityQuery(asActivityDatabase(database), activity).compile()] : [];
};
