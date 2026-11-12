import type { D1Database } from "@cloudflare/workers-types";
import { KyselyActivityStore } from "@compass/activity";
import { ConflictError } from "@compass/shared";
import { createD1Database } from "../infrastructure/database/d1/D1Dialect.ts";
import { D1WritePlan } from "../infrastructure/database/d1/D1WritePlan.ts";
import { D1PreconditionFailedError } from "../infrastructure/database/d1/D1AtomicBatch.ts";
import { asActivityDatabase } from "../infrastructure/database/contextDatabase.ts";
import { activityScopeReader } from "../infrastructure/repository/contextAdapters.ts";
import { D1ActivityStore } from "../infrastructure/repository/d1/D1ActivityStore.ts";

import type { ActivityInfrastructure } from "./activityServices.ts";

export const createD1ActivityInfrastructure = (binding: D1Database): ActivityInfrastructure => ({
  store: new KyselyActivityStore(asActivityDatabase(createD1Database(binding, { readOnly: true }))),
  unitOfWork: {
    async execute(work) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const plan = new D1WritePlan(binding, { activity: { key: ["cursor"], rowIdColumn: "cursor" } });
        try {
          const result = await work(new D1ActivityStore(plan), activityScopeReader(plan.database));
          await plan.commit();
          return result;
        } catch (error) { if (!(error instanceof D1PreconditionFailedError)) throw error; }
        finally { await plan.dispose(); }
      }
      throw new ConflictError("Activity changed repeatedly while committing; retry with the same request ID");
    },
  },
});
