/** Workが同じtransactionで読む相談の準備状態。会話・結論本文は所有しない。 */
export type ConsultationReadiness = {
  id: string;
  revision: number;
  status: "waiting_human" | "waiting_agent" | "resolved" | "canceled";
  resolutionId: string | null;
  /**
   * 結論が元Taskの再開を明示的に待たせている、まだ反映済み・取消でない文書反映Task。空なら結論の成立だけで再開できる。
   * 文書反映Taskは元Taskの受入を待たないため、循環しない。
   */
  prerequisiteTaskIds: string[];
};

export interface ConsultationReadinessPort {
  find(projectId: string, consultationId: string): Promise<ConsultationReadiness | null>;
}

export type TaskConsultationWait = {
  task_id: string;
  project_id: string;
  principal_id: string;
  role: "worker" | "reviewer" | "manager";
  phase: "work" | "review" | "acceptance";
  /** 相談ID・待機時の版・確認済み結論参照。本文を複製しない。 */
  consultations: string;
  requirement_version: string;
  /** Runtimeがfsへ保存済みのworktree/context/成果物の参照と検証版。 */
  runtime: string;
  state: "waiting" | "ready" | "resuming";
  failure_reason: string | null;
  created_at: number;
  updated_at: number;
};
