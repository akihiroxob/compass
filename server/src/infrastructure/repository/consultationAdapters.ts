
import { ActivityScope, KyselyActivityStore } from "@compass/activity";
import {
  type ConsultationFollowupLinks,
  type ConsultationScopeReader,
  type ConsultationWaitingTask,
  type FollowupTaskStatus,
} from "@compass/collaboration";
import { findProjectRepository, findWorkspaceStatus, SQLiteProjectRepository } from "@compass/organization";

import { KyselyWorkStore, TaskCoordinationService, type DirectionReferenceLookupPort } from "@compass/work";
import { asActivityDatabase, asDirectionDatabase, asOrganizationDatabase, asWorkDatabase } from "../database/contextDatabase.ts";
import { projectRepositoryReferenceFinder } from "./organizationLinks.ts";
import { workExternalReaders } from "./workReaders.ts";
import { workChangeActivityObserver } from "./activityObservers.ts";
import { activityWorkspaceId } from "./activityObservers.ts";

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
