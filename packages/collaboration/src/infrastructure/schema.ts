/**
 * Collaborationが所有するtable。単一SQLite fileの一部で、serverが他Contextのtableと合成する。
 * 選択肢・参照・根拠の発言はJSON配列。会話（message）・結論（resolution）は追記だけで、相談の行は状態・版・取消だけを更新する。
 */
export type ConsultationTable = {
  id: string;
  workspace_id: string;
  project_id: string;
  title: string;
  question: string;
  blocking_reason: string;
  options: string;
  recommendation: string;
  impact: string;
  refs: string;
  status: string;
  revision: number;
  supersedes_consultation_id: string | null;
  created_by_kind: string;
  created_by_principal_id: string;
  created_by_role: string;
  created_at: number;
  updated_at: number;
  cancel_reason: string | null;
  canceled_by_kind: string | null;
  canceled_by_principal_id: string | null;
  canceled_by_role: string | null;
  canceled_at: number | null;
};

export type ConsultationMessageTable = {
  id: string;
  consultation_id: string;
  sequence: number;
  author_kind: string;
  principal_id: string;
  role: string;
  body: string;
  corrects_message_id: string | null;
  revision: number;
  created_at: number;
};

export type ConsultationResolutionTable = {
  id: string;
  consultation_id: string;
  source: string;
  conclusion: string;
  rationale: string;
  applicability: string | null;
  selected_option: number | null;
  basis_message_ids: string;
  basis_revision: number;
  recorded_by_kind: string;
  recorded_by_principal_id: string;
  recorded_by_role: string;
  created_at: number;
};

export type ConsultationLeaseTable = {
  id: string;
  consultation_id: string;
  input_revision: number;
  principal_id: string;
  role: string;
  acquired_at: number;
  expires_at: number;
  released_at: number | null;
};

export type ConsultationCommandReceiptTable = {
  principal_id: string;
  operation: string;
  request_id: string;
  input_hash: string;
  result_json: string;
  created_at: number;
};

export type CollaborationDatabase = {
  consultation: ConsultationTable;
  consultation_message: ConsultationMessageTable;
  consultation_resolution: ConsultationResolutionTable;
  consultation_lease: ConsultationLeaseTable;
  consultation_command_receipt: ConsultationCommandReceiptTable;
};
