import type { Consultation, ConsultationMessage, ConsultationResolution, ConsultationLease, ConsultationHandoff, ConsultationFollowup, ConsultationArtifact } from "../domain/Consultation.ts";
import type { ConsultationStore } from "../application/port/ConsultationStore.ts";

/** SQLiteとD1で共有する保存値。 */
export const consultationValues = (consultation: Consultation) => ({
        id: consultation.id,
        scope: consultation.scope,
        workspace_id: consultation.workspaceId,
        project_id: consultation.projectId,
        title: consultation.title,
        question: consultation.question,
        blocking_reason: consultation.blockingReason,
        options: JSON.stringify(consultation.options),
        recommendation: consultation.recommendation,
        impact: consultation.impact,
        due_at: consultation.dueAt,
        refs: JSON.stringify(consultation.refs),
        status: consultation.status,
        revision: consultation.revision,
        supersedes_consultation_id: consultation.supersedesConsultationId,
        created_by_kind: consultation.createdBy.kind,
        created_by_principal_id: consultation.createdBy.principalId,
        created_by_role: consultation.createdBy.role,
        created_at: consultation.createdAt,
        updated_at: consultation.updatedAt,
        cancel_reason: null,
        canceled_by_kind: null,
        canceled_by_principal_id: null,
        canceled_by_role: null,
        canceled_at: null,
      });

export const messageValues = (message: ConsultationMessage) => ({
        id: message.id,
        consultation_id: message.consultationId,
        sequence: message.sequence,
        author_kind: message.author.kind,
        principal_id: message.author.principalId,
        role: message.author.role,
        body: message.body,
        corrects_message_id: message.correctsMessageId,
        revision: message.revision,
        created_at: message.createdAt,
      });

export const resolutionValues = (resolution: ConsultationResolution) => ({
        id: resolution.id,
        consultation_id: resolution.consultationId,
        source: resolution.source,
        conclusion: resolution.conclusion,
        rationale: resolution.rationale,
        applicability: resolution.applicability,
        selected_option: resolution.selectedOption,
        basis_message_ids: JSON.stringify(resolution.basisMessageIds),
        basis_revision: resolution.basisRevision,
        recorded_by_kind: resolution.recordedBy.kind,
        recorded_by_principal_id: resolution.recordedBy.principalId,
        recorded_by_role: resolution.recordedBy.role,
        created_at: resolution.createdAt,
      });

export const leaseValues = (lease: ConsultationLease) => ({
        id: lease.id,
        consultation_id: lease.consultationId,
        input_revision: lease.inputRevision,
        principal_id: lease.principalId,
        role: lease.role,
        acquired_at: lease.acquiredAt,
        expires_at: lease.expiresAt,
        released_at: lease.releasedAt,
      });

export const receiptValues = (receipt: Parameters<ConsultationStore["insertReceipt"]>[0]) => ({
        principal_id: receipt.principalId,
        operation: receipt.operation,
        request_id: receipt.requestId,
        input_hash: receipt.inputHash,
        result_json: JSON.stringify(receipt.result),
        created_at: receipt.createdAt,
      });

export const handoffValues = (handoff: ConsultationHandoff) => ({
        consultation_id: handoff.consultationId,
        project_id: handoff.projectId,
        handed_off_by_principal_id: handoff.handedOffBy.principalId,
        handed_off_by_role: handoff.handedOffBy.role,
        created_at: handoff.createdAt,
      });

export const followupValues = (followup: ConsultationFollowup) => ({
        id: followup.id,
        consultation_id: followup.consultationId,
        resolution_id: followup.resolutionId,
        kind: followup.kind,
        project_id: followup.projectId,
        repository_id: followup.repositoryId,
        task_id: followup.taskId,
        title: followup.title,
        purpose: followup.purpose,
        decision: followup.decision,
        rationale: followup.rationale,
        verification: followup.verification,
        resumption_dependency: followup.resumptionDependency,
        requested_by_principal_id: followup.requestedBy.principalId,
        requested_by_role: followup.requestedBy.role,
        created_at: followup.createdAt,
      });

export const artifactValues = (artifact: ConsultationArtifact) => ({
        id: artifact.id,
        followup_id: artifact.followupId,
        consultation_id: artifact.consultationId,
        task_id: artifact.taskId,
        repository_id: artifact.repositoryId,
        path: artifact.path,
        commit_sha: artifact.commitSha,
        pull_request_url: artifact.pullRequestUrl,
        recorded_by_principal_id: artifact.recordedBy.principalId,
        recorded_by_role: artifact.recordedBy.role,
        created_at: artifact.createdAt,
      });

export const consultationChanges = (consultation: Consultation) => {
  const { cancellation } = consultation;
  return ({
        status: consultation.status,
        revision: consultation.revision,
        updated_at: consultation.updatedAt,
        cancel_reason: cancellation?.reason ?? null,
        canceled_by_kind: cancellation?.by.kind ?? null,
        canceled_by_principal_id: cancellation?.by.principalId ?? null,
        canceled_by_role: cancellation?.by.role ?? null,
        canceled_at: cancellation?.at ?? null,
      });
};
