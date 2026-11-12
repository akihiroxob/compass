import {
  KyselyConsultationStore, consultationValues, consultationChanges, messageValues, resolutionValues,
  leaseValues, receiptValues, handoffValues, followupValues, artifactValues, type ConsultationStore,
} from "@compass/collaboration";
import { asCollaborationDatabase } from "../../database/contextDatabase.ts";
import type { D1WritePlan } from "../../database/d1/D1WritePlan.ts";

/** 読取SQL・保存値・業務判断を共有し、書込だけを外側のD1計画へ委譲する。 */
export class D1ConsultationStore extends KyselyConsultationStore {
  constructor(private readonly plan: D1WritePlan) { super(asCollaborationDatabase(plan.database)); }
  override async insertConsultation(input: Parameters<ConsultationStore["insertConsultation"]>[0]) { await this.plan.insert("consultation", consultationValues(input)); }
  override async updateConsultation(input: Parameters<ConsultationStore["updateConsultation"]>[0]) { await this.plan.update("consultation", { id: input.id }, consultationChanges(input)); }
  override async appendMessage(input: Parameters<ConsultationStore["appendMessage"]>[0]) { await this.plan.insert("consultation_message", messageValues(input)); }
  override async insertResolution(input: Parameters<ConsultationStore["insertResolution"]>[0]) { await this.plan.insert("consultation_resolution", resolutionValues(input)); }
  override async insertLease(input: Parameters<ConsultationStore["insertLease"]>[0]) { await this.plan.insert("consultation_lease", leaseValues(input)); }
  override async extendLease(id: string, expiresAt: number) { await this.plan.update("consultation_lease", { id }, { expires_at: expiresAt }); }
  override async releaseLeases(consultationId: string, releasedAt: number) {
    const rows = await this.plan.database.selectFrom("consultation_lease").select("id")
      .where("consultation_id", "=", consultationId).where("released_at", "is", null).execute();
    for (const { id } of rows) await this.plan.update("consultation_lease", { id }, { released_at: releasedAt });
  }
  override async insertReceipt(input: Parameters<ConsultationStore["insertReceipt"]>[0]) { await this.plan.insert("consultation_command_receipt", receiptValues(input)); }
  override async insertHandoff(input: Parameters<ConsultationStore["insertHandoff"]>[0]) { await this.plan.insert("consultation_handoff", handoffValues(input)); }
  override async insertFollowup(input: Parameters<ConsultationStore["insertFollowup"]>[0]) { await this.plan.insert("consultation_followup", followupValues(input)); }
  override async insertArtifact(input: Parameters<ConsultationStore["insertArtifact"]>[0]) { await this.plan.insert("consultation_artifact", artifactValues(input)); }
}
