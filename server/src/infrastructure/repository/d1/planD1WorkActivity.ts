import { D1ActivityStore } from "./D1ActivityStore.ts";
import { canonicalWorkActivity } from "@compass/activity";
import { asOrganizationDatabase } from "../../database/contextDatabase.ts";
import type { D1WorkChangePlanner } from "./D1WorkStore.ts";

export const planD1WorkActivity: D1WorkChangePlanner = async (plan, notice) => {
  if (!notice.subject) return;
  const project = await asOrganizationDatabase(plan.database).selectFrom("project").select("workspace_id").where("id", "=", notice.project_id).executeTakeFirstOrThrow();
  const activity = canonicalWorkActivity({ cursor: notice.cursor, workspaceId: project.workspace_id, projectId: notice.project_id,
    type: notice.type, principalId: notice.principal_id, payload: JSON.parse(notice.payload) as Record<string, unknown>, occurredAt: notice.occurred_at, subject: notice.subject });
  if (activity) await new D1ActivityStore(plan).append(activity);
};
