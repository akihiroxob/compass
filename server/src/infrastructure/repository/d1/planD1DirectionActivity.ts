import type { CompiledQuery, Kysely } from "kysely";
import { canonicalDirectionActivity, insertActivityQuery, type ActivityDatabase } from "@compass/activity";
import type { DirectionChangeNotice } from "@compass/direction";
import { systemActivityActor, type ActivityActorContext } from "../../../application/activityActor.ts";

export type D1DirectionActivityPlanner = (notice: DirectionChangeNotice) => CompiledQuery[];

export const planD1DirectionActivity = (database: Kysely<ActivityDatabase>, actors: ActivityActorContext): D1DirectionActivityPlanner =>
  (notice) => {
    const actor = actors.current();
    const activity = canonicalDirectionActivity({ ...notice,
      principalId: actor?.principalId ?? notice.principalId ?? systemActivityActor.principalId,
      role: actor?.role ?? systemActivityActor.role,
    });
    return activity ? [insertActivityQuery(database, activity).compile()] : [];
  };
