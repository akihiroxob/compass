import type {
  Consultation,
  ConsultationActor,
  ConsultationLease,
  ConsultationMessage,
  ConsultationResolution,
  ConsultationStatus,
} from "../../domain/Consultation.ts";

/** 相談の保存。会話・結論は追記だけで、相談の行は状態・版・取消だけを更新する。 */
export interface ConsultationStore {
  insertConsultation(consultation: Consultation): Promise<void>;
  /** 状態・版・更新日時・取消を保存する。 */
  updateConsultation(consultation: Consultation): Promise<void>;
  /** 別Projectの相談はnull（存在を区別しない）。 */
  findConsultation(projectId: string, consultationId: string): Promise<Consultation | null>;
  /** 更新日時の新しい順。 */
  listConsultations(projectId: string, query: { status?: ConsultationStatus }): Promise<Consultation[]>;
  appendMessage(message: ConsultationMessage): Promise<void>;
  /** 相談の発言（`sequence`の昇順）。 */
  listMessages(consultationId: string): Promise<ConsultationMessage[]>;
  insertResolution(resolution: ConsultationResolution): Promise<void>;
  findResolution(consultationId: string): Promise<ConsultationResolution | null>;
  insertLease(lease: ConsultationLease): Promise<void>;
  findLease(consultationId: string, leaseId: string): Promise<ConsultationLease | null>;
  /** 未解放・期限内で、入力版が`revision`のlease（あれば1件）。 */
  findActiveLease(consultationId: string, revision: number, now: number): Promise<ConsultationLease | null>;
  extendLease(leaseId: string, expiresAt: number): Promise<void>;
  /** 相談の未解放のleaseをすべて解放する（応答の完了・取消）。 */
  releaseLeases(consultationId: string, releasedAt: number): Promise<void>;
  /** 同じ主体・操作・`requestId`で保存済みの結果と入力のhash。 */
  findReceipt(principalId: string, operation: string, requestId: string): Promise<{ inputHash: string; result: unknown } | null>;
  insertReceipt(receipt: { principalId: string; operation: string; requestId: string; inputHash: string; result: unknown; createdAt: number }): Promise<void>;
}

/** 相談の所属Project（Organizationが所有）の状態と、参照として受け付けるProject ResourceのID。 */
export type ConsultationProjectState = { workspaceId: string; archived: boolean; resourceIds: string[] };

/** 相談が読む他Contextの状態。Collaborationはproject・task・storyのtableを直接読まない。 */
export interface ConsultationScopeReader {
  /** 存在しないProjectはnull。 */
  findProject(projectId: string): Promise<ConsultationProjectState | null>;
  /** Task・Story（Workが所有）がそのProjectに存在するか。 */
  workItemExists(projectId: string, kind: "task" | "story", id: string): Promise<boolean>;
}

/** 相談の照合・追記・受付記録と、他Contextの状態の読取りを同じtransactionで行う。 */
export interface ConsultationUnitOfWork {
  execute<T>(work: (store: ConsultationStore, scopes: ConsultationScopeReader) => Promise<T>): Promise<T>;
}

/**
 * Agentの認可（Accessが所有）。serverがProject Execution Role（manager / worker / reviewer）のGrantで実装し、
 * Workspace Direction Roleや他ProjectのGrantを継承しない。activeRole（`X-Compass-Active-Role`）の指定時はそのRoleだけで認可する。
 */
export interface ConsultationAgentAuthorization {
  /** Project Execution RoleのいずれかのGrant（activeRoleの指定時はそのRole）を要求し、Principalを返す。 */
  requireReader(principal: string | null, projectId: string): Promise<string>;
  /** 記録するRoleを決める。`role`の指定時はそのGrantを要求し、未指定ならactiveRole、どちらも無ければnull。 */
  resolveActor(principal: string | null, projectId: string, role: string | undefined): Promise<ConsultationActor | null>;
  /** managerのGrantを要求する（結論整理・取消）。 */
  requireManager(principal: string | null, projectId: string): Promise<ConsultationActor>;
}
