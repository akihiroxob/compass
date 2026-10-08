import {
  listGrantedRoles,
  projectRoles,
  writeProjectOwnerMembership,
  writeWorkspaceOwnerMembership,
  type AccessProjectReaders,
  type AccessWorkspaceReaders,
  type ProjectAuthorizationService,
  type ProjectRole,
} from "@compass/access";
import {
  KyselyActivityStore,
  canonicalWorkChangeTypes,
  recordCanonicalDirectionActivity,
  recordCanonicalProjectActivity,
  recordCanonicalWorkActivity,
  type ActivityAuthorizationPort,
  type ActivityProjectReader,
} from "@compass/activity";
import {
  findAdrReferencedRepositoryId,
  type DirectionChangeObserver,
  type DirectionProjectReaders,
  type DirectionWorkspaceReaders,
  recordOutcomeConfirmedEvent,
  recordRuntimeEvent,
} from "@compass/direction";
import {
  findProjectRepository,
  findProjectWorkspaceId,
  findProjectWorkspaceConstraints,
  isProjectArchived,
  isWorkspaceArchived,
  listProjectIdsInCreationOrder,
  listWorkspaceIdsInCreationOrder,
  listWorkspaceProjectIds,
  projectExists,
  SQLiteProjectRepository,
  type OwnerMembershipWriters,
  type ProjectChangeObserver,
  type ProjectRepositoryReferenceFinder,
} from "@compass/organization";
import { ConflictError, ValidationError } from "@compass/shared";
import type { WorkChangeObserver, WorkExternalReaders } from "@compass/work";
import {
  asAccessDatabase,
  asAccessTransaction,
  asActivityDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
} from "../../bootstrap/database/contextDatabase.ts";
import { currentActivityActor, systemActivityActor } from "../../application/activityActor.ts";

/**
 * Context間で同じ接続・transactionを共有する読み書きの配線。各Contextは他Contextのtableを直接扱わず、
 * 所有Contextが公開する関数をserverがここで渡す。受け取った接続・transactionのまま実行する。
 */

/** WorkがClaim・状態遷移と同じtransactionで読む、Role Grant（Access）とProject状態（Organization）。 */
export const workExternalReaders: WorkExternalReaders = (executor) => {
  const access = asAccessDatabase(executor);
  const organization = asOrganizationDatabase(executor);
  return {
    grants: {
      listRoles: (projectId, principalId) => listGrantedRoles(access, projectId, principalId),
    },
    projects: {
      exists: (projectId) => projectExists(organization, projectId),
      isArchived: (projectId) => isProjectArchived(organization, projectId),
    },
  };
};

/** AccessがMembership・Grant・Credentialの書込と同じtransactionで読む、Project状態（Organization）。 */
export const accessProjectReaders: AccessProjectReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    exists: (projectId) => projectExists(database, projectId),
    isArchived: (projectId) => isProjectArchived(database, projectId),
    listIdsInCreationOrder: () => listProjectIdsInCreationOrder(database),
  };
};

/** AccessがWorkspace Membershipの書込・初期Membershipの補完と同じtransactionで読む、Workspace状態（Organization）。 */
export const accessWorkspaceReaders: AccessWorkspaceReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    isArchived: (workspaceId) => isWorkspaceArchived(database, workspaceId),
    listIdsInCreationOrder: () => listWorkspaceIdsInCreationOrder(database),
    listProjectIds: (workspaceId) => listWorkspaceProjectIds(database, workspaceId),
  };
};

/** DirectionがIntent・Outcome等の書込と同じtransactionで読む、Project状態・Repository・所属WorkspaceのConstraints（Organization）。 */
export const directionProjectReaders: DirectionProjectReaders = (executor) => {
  const database = asOrganizationDatabase(executor);
  return {
    isArchived: (projectId) => isProjectArchived(database, projectId),
    findRepository: (projectId, repositoryId) => findProjectRepository(database, projectId, repositoryId),
    findConstraints: (projectId) => findProjectWorkspaceConstraints(database, projectId),
    findWorkspaceId: (projectId) => findProjectWorkspaceId(database, projectId),
  };
};

/** Intent/Outcomeが直接読むWorkspaceの状態。Projectを経由しない。 */
export const directionWorkspaceReaders: DirectionWorkspaceReaders = (executor) => ({
  resourceBelongsToWorkspace: async (workspaceId, resourceId) => {
    const row = await asOrganizationDatabase(executor).selectFrom("project_resource")
      .innerJoin("project", "project.id", "project_resource.project_id")
      .select("project_resource.id").where("project_resource.id", "=", resourceId)
      .where("project.workspace_id", "=", workspaceId).executeTakeFirst();
    return row !== undefined;
  },
  isArchived: (workspaceId) => isWorkspaceArchived(asOrganizationDatabase(executor), workspaceId),
});

/** OrganizationのWorkspace・Project作成のtransactionで、作成者の初期owner Membership（Access）を書く。 */
export const ownerMembershipWriters: OwnerMembershipWriters = {
  project: (transaction, input) => writeProjectOwnerMembership(asAccessTransaction(transaction), input),
  workspace: (transaction, input) => writeWorkspaceOwnerMembership(asAccessTransaction(transaction), input),
};

/** OrganizationがRepositoryを外すtransactionで、ADR Handoff Request/Reference（Direction）からの参照を読む。 */
export const projectRepositoryReferenceFinder: ProjectRepositoryReferenceFinder = (transaction, repositoryIds) =>
  findAdrReferencedRepositoryId(asDirectionDatabase(transaction), repositoryIds);

/** Activityの所属は状態変更・appendと同じtransactionで解決し、欠損は補正せず拒否する。 */
const activityWorkspaceId = async (executor: Parameters<typeof asOrganizationDatabase>[0], projectId: string): Promise<string> => {
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
    if (notice.subject === null || !canonicalWorkChangeTypes.includes(notice.type)) return;
    await recordCanonicalWorkActivity(store, {
      workspaceId: await activityWorkspaceId(executor, notice.project_id),
      cursor: notice.cursor,
      projectId: notice.project_id,
      type: notice.type,
      principalId: notice.principal_id,
      payload: JSON.parse(notice.payload) as Record<string, unknown>,
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
    const actor = currentActivityActor();
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
    const actor = currentActivityActor() ?? systemActivityActor;
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

/** Activityが参照するProject（Organization）の状態と、登録済みRepository・ResourceのID。 */
export const activityProjectReader = (executor: Parameters<typeof asOrganizationDatabase>[0]): ActivityProjectReader => {
  const projects = new SQLiteProjectRepository(asOrganizationDatabase(executor), projectRepositoryReferenceFinder);
  return {
    find: async (projectId) => {
      const project = await projects.findById(projectId);
      if (!project) return null;
      return {
        workspaceId: project.workspaceId,
        archived: project.status === "archived",
        resourceIds: [...project.repositories, ...project.resources].map(({ id }) => id),
      };
    },
  };
};

const isProjectRole = (role: string): role is ProjectRole => (projectRoles as readonly string[]).includes(role);

/** ActivityのAgent認可を、AccessのProject Role Grant（activeRoleの固定を含む）で行う。 */
export const activityAuthorization = (authorization: ProjectAuthorizationService): ActivityAuthorizationPort => ({
  requireReader: (principal, projectId) => authorization.requireAnyRole(principal, projectId),
  resolveActor: async (principal, projectId, role) => {
    if (role !== undefined) {
      if (!isProjectRole(role)) {
        throw new ValidationError("Activity input is invalid", [{ path: "role", message: `role must be one of ${projectRoles.join(", ")}` }]);
      }
      return { principalId: await authorization.requireRole(principal, projectId, role), role };
    }
    if (authorization.activeRole === null) return null;
    return { principalId: await authorization.requireAnyRole(principal, projectId), role: authorization.activeRole };
  },
});
