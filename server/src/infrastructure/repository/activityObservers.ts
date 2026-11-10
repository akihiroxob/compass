import { KyselyActivityStore, isCanonicalWorkChange, recordCanonicalDirectionActivity, recordCanonicalProjectActivity, recordCanonicalWorkActivity } from "@compass/activity";
import { type DirectionChangeObserver, recordOutcomeConfirmedEvent, recordRuntimeEvent } from "@compass/direction";
import { findProjectWorkspaceId, type ProjectChangeObserver } from "@compass/organization";
import { ConflictError } from "@compass/shared";
import { type WorkChangeObserver } from "@compass/work";
import { asActivityDatabase, asDirectionDatabase, asOrganizationDatabase } from "../database/contextDatabase.ts";
import { systemActivityActor } from "../../application/activityActor.ts";
import { activityActorContext } from "../activity/NodeActivityActorContext.ts";

/** Activityの所属Workspaceは状態変更・appendと同じtransactionで読む。Projectが無ければ補正せず拒否する。 */
export const activityWorkspaceId = async (executor: Parameters<typeof asOrganizationDatabase>[0], projectId: string): Promise<string> => {
  const workspaceId = await findProjectWorkspaceId(asOrganizationDatabase(executor), projectId);
  if (!workspaceId) throw new ConflictError(`Project ${projectId} has no Workspace for Activity`, { projectId });
  return workspaceId;
};

/**
 * Workの重要な状態変更から、同じtransactionでcanonical Activityを追記する。生成元Changeのcursorで一意にするため、
 * 再送（Command Receiptの再生ではChangeを追記しない）・再試行で重複しない。Activityの追記に失敗すれば状態変更も巻き戻る。
 */
export const workChangeActivityObserver: WorkChangeObserver = (executor) => {
  const store = new KyselyActivityStore(asActivityDatabase(executor));
  return async (notice) => {
    const payload = JSON.parse(notice.payload) as Record<string, unknown>;
    if (notice.subject === null || !isCanonicalWorkChange(notice.type, payload)) return;
    await recordCanonicalWorkActivity(store, {
      workspaceId: await activityWorkspaceId(executor, notice.project_id),
      cursor: notice.cursor,
      projectId: notice.project_id,
      type: notice.type,
      principalId: notice.principal_id,
      payload,
      occurredAt: notice.occurred_at,
      subject: notice.subject,
    });
  };
};

/**
 * Directionの重要な状態変更から、同じtransactionでcanonical Activityを追記する。変更されたrecordと種類で一意にするため、
 * 再送（requestKeyの再生では通知しない）・再試行で重複しない。Activityの追記に失敗すれば状態変更も巻き戻る。
 * 操作者は入口が固定した主体（`withActivityActor`）を使い、無ければDirectionの来歴、それも無ければ`system`とする。
 */
export const directionChangeActivityObserver: DirectionChangeObserver = (executor) => {
  const store = new KyselyActivityStore(asActivityDatabase(executor));
  return async (notice) => {
    const actor = activityActorContext.current();
    await recordCanonicalDirectionActivity(store, {
      ...notice,
      // Directionが所有するWorkspace IDを直接使う。
      workspaceId: notice.workspaceId,
      principalId: actor?.principalId ?? notice.principalId ?? systemActivityActor.principalId,
      role: actor?.role ?? systemActivityActor.role,
    });
  };
};

/**
 * Directionの状態変更を同じtransactionでWorkspace ActivityとWorkspace Runtime eventへ投影する。
 */
export const directionChangeObserver: DirectionChangeObserver = (executor) => {
  const activity = directionChangeActivityObserver(executor);
  return async (notice) => {
    await activity(notice);
    if ((notice.type === "research_requested" || notice.type === "research_closed")) {
      const request = await asDirectionDatabase(executor).selectFrom("research_request").selectAll().where("id", "=", notice.recordId).executeTakeFirstOrThrow();
      const intent = request.origin_intent_id ? await asDirectionDatabase(executor).selectFrom("intent").select("status").where("id", "=", request.origin_intent_id).executeTakeFirst() : null;
      if (notice.type === "research_requested" || (notice.result !== "cancelled" && intent?.status === "active")) {
        await recordRuntimeEvent(executor, {
          type: notice.type === "research_requested" ? "research_requested" : "research_completed",
          workspaceId: notice.workspaceId, intentId: request.origin_intent_id, researchRequestId: request.id,
          correlationId: request.correlation_id,
          conclusion: notice.type === "research_requested" ? null : request.status as "completed" | "insufficient" | "not_needed",
          occurredAt: notice.occurredAt,
        });
      }
    }
    // Outcome確定はProjectの数によらずWorkspace eventとして保存する。
    if (notice.type === "outcome_confirmed") {
      const intentId = notice.refs.find(ref => ref.kind === "intent")?.id;
      if (intentId) {
        await recordOutcomeConfirmedEvent(executor, { workspaceId: notice.workspaceId, intentId, outcomeId: notice.recordId, occurredAt: notice.occurredAt });
      }
    }
  };
};

/**
 * Projectのarchive（Organization）から、同じtransactionでproject scopeのcanonical Activityを追記する。Projectごとに一意で、
 * 再試行で重複しない。Activityの追記に失敗すればarchiveも巻き戻る。操作者は入口が固定した主体、無ければ`system`とする。
 */
export const projectChangeActivityObserver: ProjectChangeObserver = (executor) => {
  const store = new KyselyActivityStore(asActivityDatabase(executor));
  return async (notice) => {
    const actor = activityActorContext.current() ?? systemActivityActor;
    await recordCanonicalProjectActivity(store, {
      type: notice.type,
      workspaceId: await activityWorkspaceId(executor, notice.projectId),
      projectId: notice.projectId,
      title: notice.title,
      reason: notice.reason,
      principalId: actor.principalId,
      role: actor.role,
      occurredAt: notice.occurredAt,
    });
  };
};
