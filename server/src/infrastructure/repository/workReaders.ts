import { KyselyConsultationStore } from "@compass/collaboration";
import { listGrantedRoles } from "@compass/access";
import { blocksResumption, reflectionStatusOf, type FollowupTaskStatus } from "@compass/collaboration";
import { isOutcomeTargetProject } from "@compass/direction";
import { findProjectRepository, findProjectRepositoryRequiredChecks, isProjectArchived, projectExists } from "@compass/organization";
import { type WorkExternalReaders } from "@compass/work";
import { asAccessDatabase, asCollaborationDatabase, asDirectionDatabase, asOrganizationDatabase, asWorkDatabase } from "../database/contextDatabase.ts";

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
      findRequiredChecks: (projectId, repositoryId) => findProjectRepositoryRequiredChecks(organization, projectId, repositoryId),
    },
    outcomeTargets: {
      isTarget: (outcomeId, projectId) => isOutcomeTargetProject(direction, outcomeId, projectId),
    },
  };
};
