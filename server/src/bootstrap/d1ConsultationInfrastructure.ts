import type { D1Database } from "@cloudflare/workers-types";
import type { ConsultationUnitOfWork } from "@compass/collaboration";
import type { DirectionReferenceLookupPort } from "@compass/work";
import { ConflictError } from "@compass/shared";
import { D1WritePlan } from "../infrastructure/database/d1/D1WritePlan.ts";
import { D1PreconditionFailedError } from "../infrastructure/database/d1/D1AtomicBatch.ts";
import { asWorkDatabase } from "../infrastructure/database/contextDatabase.ts";
import { consultationFollowupLinks, consultationScopeReader } from "../infrastructure/repository/consultationAdapters.ts";
import { workExternalReaders } from "../infrastructure/repository/workReaders.ts";
import { D1ConsultationStore } from "../infrastructure/repository/d1/D1ConsultationStore.ts";
import { D1ActivityStore } from "../infrastructure/repository/d1/D1ActivityStore.ts";
import { D1WorkStore, d1WorkPlanTables } from "../infrastructure/repository/d1/D1WorkStore.ts";
import { planD1WorkActivity } from "../infrastructure/repository/d1/planD1WorkActivity.ts";

/** 相談・文書反映Task・Receipt・Change・Activityを一つの保存計画で確定する。 */
export const createD1ConsultationInfrastructure = (binding: D1Database, directionReferences: DirectionReferenceLookupPort, clock: () => number): ConsultationUnitOfWork => ({
  async execute(work) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const plan = new D1WritePlan(binding, {
        ...d1WorkPlanTables,
        consultation: { key: ["id"] }, consultation_message: { key: ["id"] }, consultation_resolution: { key: ["id"] },
        consultation_lease: { key: ["id"] }, consultation_command_receipt: { key: ["principal_id", "operation", "request_id"] },
        consultation_handoff: { key: ["consultation_id", "project_id"] }, consultation_followup: { key: ["id"] }, consultation_artifact: { key: ["id"] },
      });
      try {
        const result = await work(new D1ConsultationStore(plan), consultationScopeReader(plan.database), consultationFollowupLinks(plan.database, {
          directionReferences, clock, activityStore: new D1ActivityStore(plan),
          workStore: new D1WorkStore(asWorkDatabase(plan.database), binding, workExternalReaders, planD1WorkActivity, plan),
        }));
        await plan.commit();
        return result;
      } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
      finally { await plan.dispose(); }
    }
    throw new ConflictError("Consultation changed repeatedly while committing; retry with the same request ID");
  },
});
