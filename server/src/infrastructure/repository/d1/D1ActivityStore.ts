import { KyselyActivityStore, activityValues, type NewActivity } from "@compass/activity";
import { asActivityDatabase } from "../../database/contextDatabase.ts";
import type { D1WritePlan } from "../../database/d1/D1WritePlan.ts";

/** 外側の保存計画に参加し、重複照合も同じ前提条件で確定する。 */
export class D1ActivityStore extends KyselyActivityStore {
  constructor(private readonly plan: D1WritePlan) { super(asActivityDatabase(plan.database)); }

  override async append(activity: NewActivity) {
    const existing = await this.findByDedupeKey(activity.dedupeKey);
    if (existing) return { ...existing, created: false };
    const cursor = await this.plan.nextRowId("activity");
    await this.plan.insert("activity", { ...activityValues(activity), cursor });
    const stored = await this.findByDedupeKey(activity.dedupeKey);
    if (!stored) throw new Error("Planned Activity was not readable");
    return { ...stored, created: true };
  }
}
