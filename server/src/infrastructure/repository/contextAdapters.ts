import { KyselyConsultationStore } from "@compass/collaboration";
import {
  listGrantedRoles,
  projectRoles,
  writeProjectOwnerMembership,
  writeWorkspaceOwnerMembership,
  type AccessProjectReaders,
  type AccessWorkspaceReaders,
  type ProjectAuthorizationService,
  type ProjectRole,
  type RoleScopeAuthorizationService,
} from "@compass/access";
import {
  ActivityScope,
  KyselyActivityStore,
  canonicalWorkChangeTypes,
  recordCanonicalDirectionActivity,
  recordCanonicalProjectActivity,
  recordCanonicalWorkActivity,
  type ActivityAuthorizationPort,
  type ActivityScopeReader,
  type ActivityTarget,
} from "@compass/activity";
import {
  blocksResumption,
  consultationResponderRole,
  reflectionStatusOf,
  type ConsultationAgentAuthorization,
  type ConsultationFollowupLinks,
  type ConsultationScope,
  type ConsultationScopeReader,
  type ConsultationWaitingTask,
  type FollowupTaskStatus,
} from "@compass/collaboration";
import {
  findAdrReferencedRepositoryId,
  isOutcomeTargetProject,
  type DirectionChangeObserver,
  type DirectionProjectReaders,
  type DirectionWorkspaceReaders,
  recordOutcomeConfirmedEvent,
  recordRuntimeEvent,
} from "@compass/direction";
import {
  findProjectRepository,
  findProjectWorkspaceId,
  findWorkspaceStatus,
  findProjectWorkspaceConstraints,
  isProjectArchived,
  findArchivedProjectIds,
  isWorkspaceArchived,
  listProjectIdsInCreationOrder,
  listWorkspaceIdsInCreationOrder,
  listWorkspaceProjectIds,
  listWorkspaceProjectResourceIds,
  projectExists,
  SQLiteProjectRepository,
  type OwnerMembershipWriters,
  type ProjectChangeObserver,
  type ProjectRepositoryReferenceFinder,
} from "@compass/organization";
import { ConflictError, ValidationError } from "@compass/shared";
import {
  KyselyWorkStore,
  TaskCoordinationService,
  type DirectionReferenceLookupPort,
  type WorkChangeObserver,
  type WorkExternalReaders,
} from "@compass/work";
import {
  asAccessDatabase,
  asCollaborationDatabase,
  asAccessTransaction,
  asActivityDatabase,
  asDirectionDatabase,
  asOrganizationDatabase,
  asWorkDatabase,
} from "../../bootstrap/database/contextDatabase.ts";
import { currentActivityActor, systemActivityActor } from "../../application/activityActor.ts";

/**
 * Context間で同じ接続・transactionを共有する読み書きの配線。各Contextは他Contextのtableを直接扱わず、
 * 所有Contextが公開する関数をserverがここで渡す。受け取った接続・transactionのまま実行する。
 */

/**
 * WorkがClaim・状態遷移と同じtransactionで読む、Role Grant（Access）とProject状態（Organization）、
 * Story保存時に再検査するOutcome Target（Direction）。
 */
export const workExternalReaders: WorkExternalReaders = (executor) => {
  const access = asAccessDatabase(executor);
  const organization = asOrganizationDatabase(executor);
  const direction = asDirectionDatabase(executor);
  const collaboration = new KyselyConsultationStore(asCollaborationDatabase(executor));
  return {
    consultations: {
      find: async (projectId, consultationId) => {
        // Taskの待機に使えるのは同じProjectのProject相談だけ。Workspace相談・別Projectの相談IDは存在しないものとして扱う。
        const consultation = await collaboration.findConsultation({ kind: "project", projectId }, consultationId);
        if (!consultation) return null;
        const resolution = await collaboration.findResolution(consultationId);
        // 結論が明示した文書反映の依存のうち、まだ反映済み・取消でないものだけを再開の待機条件として返す。
        const [followups, artifacts] = await Promise.all([collaboration.listFollowups(consultationId), collaboration.listArtifacts(consultationId)]);
        const prerequisiteTaskIds: string[] = [];
        for (const followup of followups.filter(({ resumptionDependency }) => resumptionDependency !== null)) {
          const task = await asWorkDatabase(executor).selectFrom("task").select("status").where("id", "=", followup.taskId).executeTakeFirst();
          const reflected = artifacts.filter(({ followupId }) => followupId === followup.id).length;
          const status = task ? reflectionStatusOf(task.status as FollowupTaskStatus, reflected) : "in_progress";
          if (blocksResumption(followup, status)) prerequisiteTaskIds.push(followup.taskId);
        }
        return { id: consultation.id, status: consultation.status, revision: consultation.revision, resolutionId: resolution?.id ?? null, prerequisiteTaskIds };
      },
    },
    grants: {
      listRoles: (projectId, principalId) => listGrantedRoles(access, projectId, principalId),
    },
    projects: {
      exists: (projectId) => projectExists(organization, projectId),
      isArchived: (projectId) => isProjectArchived(organization, projectId),
      findRepository: async (projectId, repositoryId) => (await findProjectRepository(organization, projectId, repositoryId)) ?? null,
    },
    outcomeTargets: {
      isTarget: (outcomeId, projectId) => isOutcomeTargetProject(direction, outcomeId, projectId),
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
    findArchivedIds: (projectIds) => findArchivedProjectIds(database, projectIds),
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

/** Activityの所属Workspaceは状態変更・appendと同じtransactionで読む。Projectが無ければ補正せず拒否する。 */
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

/**
 * Activityの記録・取得の対象（Organization）の状態と、`project_resource`参照として受け付けるRepository・ResourceのID。
 * ProjectはそのProjectに登録済みのもの、Workspaceは所属Project（archivedを含む）に登録済みのものを返す。
 */
export const activityScopeReader = (executor: Parameters<typeof asOrganizationDatabase>[0]): ActivityScopeReader => {
  const database = asOrganizationDatabase(executor);
  const projects = new SQLiteProjectRepository(database, projectRepositoryReferenceFinder);
  return {
    find: async (target) => {
      if (target.kind === "workspace") {
        const status = await findWorkspaceStatus(database, target.id);
        if (status === null) return null;
        return {
          workspaceId: target.id,
          projectId: null,
          archived: status === "archived",
          resourceIds: await listWorkspaceProjectResourceIds(database, target.id),
        };
      }
      const project = await projects.findById(target.id);
      if (!project) return null;
      return {
        workspaceId: project.workspaceId,
        projectId: project.id,
        archived: project.status === "archived",
        resourceIds: [...project.repositories, ...project.resources].map(({ id }) => id),
      };
    },
  };
};

const isProjectRole = (role: string): role is ProjectRole => (projectRoles as readonly string[]).includes(role);

/**
 * ActivityのAgent認可（activeRoleの固定を含む）。ProjectはAccessのProject Role Grant、WorkspaceはWorkspace Role Grantで検査し、
 * 互いに継承・合算しない。Workspace scopeではExecution Role、Project scopeでは新規発行できないDirection RoleのGrantを
 * Roleのscope検査で拒否する（Project scopeの旧Direction Grantは`ProjectAuthorizationService`の移行経路のまま）。
 */
export const activityAuthorization = (
  projectAuthorization: ProjectAuthorizationService,
  roleScopeAuthorization: RoleScopeAuthorizationService,
): ActivityAuthorizationPort => {
  const requireReader = (principal: string | null, target: ActivityTarget) =>
    target.kind === "workspace"
      ? roleScopeAuthorization.requireAnyRole(principal, target)
      : projectAuthorization.requireAnyRole(principal, target.id);
  return {
    requireReader,
    resolveActor: async (principal, target, role) => {
      if (role !== undefined) {
        if (!isProjectRole(role)) {
          throw new ValidationError("Activity input is invalid", [{ path: "role", message: `role must be one of ${projectRoles.join(", ")}` }]);
        }
        const principalId = target.kind === "workspace"
          ? await roleScopeAuthorization.requireRole(principal, target, role)
          : await projectAuthorization.requireRole(principal, target.id, role);
        return { principalId, role };
      }
      if (projectAuthorization.activeRole === null) return null;
      return { principalId: await requireReader(principal, target), role: projectAuthorization.activeRole };
    },
  };
};

/**
 * 相談（Collaboration）が書込と同じtransactionで読む、scopeのProject・Workspaceの状態・所属Workspace・Resource（Organization）と、
 * 参照先のTask・Story（Work）・Intent・Outcome（Direction）の所属。Collaborationは他Contextのtableを直接読まない。
 */
export const consultationScopeReader = (executor: Parameters<typeof asOrganizationDatabase>[0]): ConsultationScopeReader => {
  const organization = asOrganizationDatabase(executor);
  const projects = new SQLiteProjectRepository(organization, projectRepositoryReferenceFinder);
  const work = asWorkDatabase(executor);
  const direction = asDirectionDatabase(executor);
  return {
    findScope: async (scope) => {
      if (scope.kind === "workspace") {
        const status = await findWorkspaceStatus(organization, scope.workspaceId);
        return status === null ? null : { workspaceId: scope.workspaceId, archived: status === "archived", resourceIds: [] };
      }
      const project = await projects.findById(scope.projectId);
      if (!project) return null;
      return {
        workspaceId: project.workspaceId,
        archived: project.status === "archived",
        resourceIds: [...project.repositories, ...project.resources].map(({ id }) => id),
      };
    },
    workItemExists: async (projectId, kind, id) => {
      const row = kind === "task"
        ? await work.selectFrom("task").select("id").where("id", "=", id).where("project_id", "=", projectId).executeTakeFirst()
        : await work.selectFrom("story").select("id").where("id", "=", id).where("project_id", "=", projectId).executeTakeFirst();
      return row !== undefined;
    },
    directionItemExists: async (workspaceId, reference) => {
      const row = reference.kind === "intent"
        ? await direction.selectFrom("intent").select("id").where("id", "=", reference.id).where("workspace_id", "=", workspaceId).executeTakeFirst()
        : await direction.selectFrom("outcome").select("id").where("id", "=", reference.id).where("intent_id", "=", reference.intentId)
          .where("workspace_id", "=", workspaceId).executeTakeFirst();
      return row !== undefined;
    },
  };
};

/**
 * 相談の文書反映（Collaboration）が同じtransactionで使う、Work Taskの起票・読取（Work）、Repository（Organization）、
 * 相談待ちTask（Workの待機関係）、意味的な履歴（Activity）。Taskの起票はWorkの通常の起票処理（Project Grant・activeRole・
 * Projectの状態・受付記録・Change Log・canonical Activity）をそのまま使い、業務規則を複製しない。
 */
export const consultationFollowupLinks = (
  executor: Parameters<typeof asOrganizationDatabase>[0],
  options: { directionReferences: DirectionReferenceLookupPort; clock: () => number },
): ConsultationFollowupLinks => {
  const organization = asOrganizationDatabase(executor);
  const work = asWorkDatabase(executor);
  const activities = new KyselyActivityStore(asActivityDatabase(executor));
  return {
    issueTask: async (actor, input, requestId) => {
      const store = new KyselyWorkStore(work, workExternalReaders, workChangeActivityObserver);
      const service = new TaskCoordinationService(store, options.directionReferences, options.clock).forActiveRole(actor.role);
      const task = await service.issueTask(
        actor.principalId,
        { projectId: input.projectId, ...(input.storyId === null ? {} : { storyId: input.storyId }), title: input.title, description: input.description },
        requestId,
      );
      return { id: task.id };
    },
    findTask: async (projectId, taskId) => {
      const row = await work.selectFrom("task").select(["id", "title", "status"]).where("id", "=", taskId).where("project_id", "=", projectId).executeTakeFirst();
      return row ? { id: row.id, title: row.title, status: row.status as FollowupTaskStatus } : null;
    },
    findAcceptedDeliverables: (projectId, taskId) =>
      new KyselyWorkStore(work, workExternalReaders, workChangeActivityObserver).findAcceptedDeliverables(projectId, taskId),
    findRepository: async (projectId, repositoryId) => (await findProjectRepository(organization, projectId, repositoryId)) ?? null,
    findProject: async (projectId) =>
      (await organization.selectFrom("project").select(["id", "name"]).where("id", "=", projectId).executeTakeFirst()) ?? null,
    listWaitingTasks: async (projectId, consultationId) => {
      const rows = await work
        .selectFrom("task_consultation_wait")
        .innerJoin("task", "task.id", "task_consultation_wait.task_id")
        .select(["task.id", "task.title", "task.status", "task_consultation_wait.phase", "task_consultation_wait.state",
          "task_consultation_wait.failure_reason", "task_consultation_wait.consultations"])
        .where("task_consultation_wait.project_id", "=", projectId)
        .orderBy("task_consultation_wait.created_at")
        .execute();
      return rows
        .filter((row) => (JSON.parse(row.consultations) as { id: string }[]).some(({ id }) => id === consultationId))
        .map((row): ConsultationWaitingTask => ({
          taskId: row.id, title: row.title, status: row.status as FollowupTaskStatus, phase: row.phase, state: row.state, failureReason: row.failure_reason,
        }));
    },
    recordActivity: async (fact) => {
      const artifactRefs = fact.artifact
        ? [
          { kind: "project_resource" as const, resourceId: fact.artifact.repositoryId, path: fact.artifact.path, revision: fact.artifact.commitSha },
          ...(fact.artifact.pullRequestUrl ? [{ kind: "url" as const, url: fact.artifact.pullRequestUrl }] : []),
        ]
        : [];
      await activities.append({
        id: crypto.randomUUID(),
        scope: ActivityScope.PROJECT,
        workspaceId: await activityWorkspaceId(executor, fact.projectId),
        projectId: fact.projectId,
        type: fact.type,
        principalId: fact.actor.principalId,
        role: fact.actor.role,
        summary: fact.summary,
        body: null,
        refs: [
          { kind: fact.consultationScope === "workspace" ? "workspace_consultation" : "consultation", id: fact.consultationId },
          { kind: "task", id: fact.taskId },
          ...artifactRefs,
        ],
        correctsActivityId: null,
        source: "canonical",
        occurredAt: fact.occurredAt,
        recordedAt: fact.occurredAt,
        dedupeKey: fact.artifact
          ? `${fact.type}:${fact.taskId}:${fact.artifact.path}:${fact.artifact.commitSha}`
          : `${fact.type}:${fact.taskId}`,
        inputHash: null,
      });
    },
  };
};

/**
 * 相談のAgent認可（activeRoleの固定を含む）。相談のscopeのRole Grantだけで認可する。ProjectはExecution Role（manager / worker / reviewer）、
 * WorkspaceはDirection Role（strategist / researcher / evaluator）で、WorkspaceとProjectの間・旧Project Direction Grant・他scopeのGrantでは
 * 参照・記録させない。結論整理・取消はscopeの応答Role（ProjectはManager、WorkspaceはStrategist）。
 */
export const consultationAgentAuthorization = (roleScopeAuthorization: RoleScopeAuthorizationService): ConsultationAgentAuthorization => {
  const roleScope = (scope: ConsultationScope) =>
    scope.kind === "project" ? { kind: "project" as const, id: scope.projectId } : { kind: "workspace" as const, id: scope.workspaceId };
  return {
    requireReader: async (principal, scope) => (await roleScopeAuthorization.requireScopedRole(principal, roleScope(scope))).principalId,
    resolveActor: async (principal, scope, role) => {
      const actorRole = role ?? roleScopeAuthorization.activeRole;
      if (actorRole === null || actorRole === undefined) return null;
      if (!isProjectRole(actorRole)) {
        throw new ValidationError("Consultation input is invalid", [{ path: "role", message: `role must be one of ${projectRoles.join(", ")}` }]);
      }
      // scopeに属さないRole（Project相談のstrategist、Workspace相談のworker等）はGrantの有無によらずFORBIDDEN。
      const principalId = await roleScopeAuthorization.requireRole(principal, roleScope(scope), actorRole);
      return { kind: "agent", principalId, role: actorRole };
    },
    requireResponder: async (principal, scope) => {
      const role = consultationResponderRole(scope.kind);
      return { kind: "agent", principalId: await roleScopeAuthorization.requireRole(principal, roleScope(scope), role), role };
    },
    requireProjectManager: async (principal, projectId) => ({
      kind: "agent",
      principalId: await roleScopeAuthorization.requireRole(principal, { kind: "project", id: projectId }, "manager"),
      role: "manager",
    }),
    listReadableProjectIds: (principal) => roleScopeAuthorization.listScopedProjectIds(principal),
  };
};
