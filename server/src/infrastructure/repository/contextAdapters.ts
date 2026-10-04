import {
  listGrantedRoles,
  projectRoles,
  writeProjectOwnerMembership,
  type AccessProjectReaders,
  type ProjectAuthorizationService,
  type ProjectRole,
} from "@compass/access";
import {
  KyselyActivityStore,
  recordCanonicalDirectionActivity,
  recordCanonicalWorkActivity,
  type ActivityAuthorizationPort,
  type ActivityProjectReader,
} from "@compass/activity";
import {
  isProjectArchived,
  listProjectIdsInCreationOrder,
  SQLiteProjectRepository,
  type DirectionChangeObserver,
  type ProjectOwnerMembershipWriter,
} from "@compass/direction";
import { ValidationError } from "@compass/shared";
import type { WorkChangeObserver, WorkExternalReaders } from "@compass/work";
import {
  asAccessDatabase,
  asAccessTransaction,
  asActivityDatabase,
  asDirectionDatabase,
} from "../../bootstrap/database/contextDatabase.ts";
import { currentActivityActor, systemActivityActor } from "../../application/activityActor.ts";

/**
 * Context間で同じ接続・transactionを共有する読み書きの配線。各Contextは他Contextのtableを直接扱わず、
 * 所有Contextが公開する関数をserverがここで渡す。受け取った接続・transactionのまま実行する。
 */

/** WorkがClaim・状態遷移と同じtransactionで読む、Role Grant（Access）とProject状態（Direction）。 */
export const workExternalReaders: WorkExternalReaders = (executor) => {
  const access = asAccessDatabase(executor);
  const direction = asDirectionDatabase(executor);
  const projects = new SQLiteProjectRepository(direction);
  return {
    grants: {
      listRoles: (projectId, principalId) => listGrantedRoles(access, projectId, principalId),
    },
    projects: {
      exists: (projectId) => projects.exists(projectId),
      isArchived: (projectId) => isProjectArchived(direction, projectId),
    },
  };
};

/** AccessがMembership・Grant・Credentialの書込と同じtransactionで読む、Project状態（Direction）。 */
export const accessProjectReaders: AccessProjectReaders = (executor) => {
  const database = asDirectionDatabase(executor);
  const projects = new SQLiteProjectRepository(database);
  return {
    exists: (projectId) => projects.exists(projectId),
    isArchived: (projectId) => isProjectArchived(database, projectId),
    listIdsInCreationOrder: () => listProjectIdsInCreationOrder(database),
  };
};

/** DirectionのProject作成のtransactionで、作成者の初期owner Membership（Access）を書く。 */
export const projectOwnerMembershipWriter: ProjectOwnerMembershipWriter = (transaction, input) =>
  writeProjectOwnerMembership(asAccessTransaction(transaction), input);

/**
 * Workの重要な状態変更から、同じtransactionでcanonical Activityを追記する。生成元Changeのcursorで一意にするため、
 * 再送（Command Receiptの再生ではChangeを追記しない）・再試行で重複しない。Activityの追記に失敗すれば状態変更も巻き戻る。
 */
export const workChangeActivityObserver: WorkChangeObserver = (executor) => {
  const store = new KyselyActivityStore(asActivityDatabase(executor));
  return async (notice) => {
    if (notice.subject === null) return;
    await recordCanonicalWorkActivity(store, {
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
      principalId: actor?.principalId ?? notice.principalId ?? systemActivityActor.principalId,
      role: actor?.role ?? systemActivityActor.role,
    });
  };
};

/** Activityが参照するProject（Direction）の状態と、登録済みRepository・ResourceのID。 */
export const activityProjectReader = (executor: Parameters<typeof asDirectionDatabase>[0]): ActivityProjectReader => {
  const projects = new SQLiteProjectRepository(asDirectionDatabase(executor));
  return {
    find: async (projectId) => {
      const project = await projects.findById(projectId);
      if (!project) return null;
      return {
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
