import type {
  Consultation,
  ConsultationActor,
  ConsultationArtifact,
  ConsultationFollowup,
  ConsultationLease,
  ConsultationMessage,
  ConsultationReference,
  ConsultationResolution,
  ConsultationScope,
  ConsultationStatus,
  FollowupTaskStatus,
} from "../../domain/Consultation.ts";

/** 横断一覧の位置（更新日時の降順・同時刻はIDの昇順）。この位置より後ろを返す。 */
export type ConsultationCursor = { updatedAt: number; id: string };

/**
 * 横断一覧の条件。`projectIds`・`workspaceIds`は呼出し主体が閲覧できるscopeで、Project scopeの相談は`projectIds`、
 * Workspace scopeの相談は`workspaceIds`に含まれるものだけを返す。絞り込み・ページングはこの認可済みの集合に対して行う。
 */
export type AccessibleConsultationQuery = {
  projectIds: readonly string[];
  workspaceIds: readonly string[];
  status?: ConsultationStatus;
  /** 所属Workspace（Project scopeの相談は所属ProjectのWorkspace）で絞る。 */
  workspaceId?: string;
  /** Project scopeの相談をそのProjectに絞る。 */
  projectId?: string;
  after?: ConsultationCursor;
  limit: number;
};

/** 相談の保存。会話・結論は追記だけで、相談の行は状態・版・取消だけを更新する。 */
export interface ConsultationStore {
  insertConsultation(consultation: Consultation): Promise<void>;
  /** 状態・版・更新日時・取消を保存する。 */
  updateConsultation(consultation: Consultation): Promise<void>;
  /** 別scope（別Project・別Workspace、ProjectとWorkspaceの違い）の相談はnull（存在を区別しない）。 */
  findConsultation(scope: ConsultationScope, consultationId: string): Promise<Consultation | null>;
  /** scopeの相談（更新日時の新しい順）。 */
  listConsultations(scope: ConsultationScope, query: { status?: ConsultationStatus }): Promise<Consultation[]>;
  /** 閲覧できるscopeを横断した相談（更新日時の新しい順・同時刻はIDの昇順）を`limit`件まで。 */
  listAccessibleConsultations(query: AccessibleConsultationQuery): Promise<Consultation[]>;
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
  insertFollowup(followup: ConsultationFollowup): Promise<void>;
  /** 同じ相談・種類・反映先（Project・Repository）の依頼。 */
  findFollowupByTarget(consultationId: string, target: Pick<ConsultationFollowup, "kind" | "projectId" | "repositoryId">): Promise<ConsultationFollowup | null>;
  /** 別の相談の依頼IDはnull。 */
  findFollowup(consultationId: string, followupId: string): Promise<ConsultationFollowup | null>;
  listFollowups(consultationId: string): Promise<ConsultationFollowup[]>;
  insertArtifact(artifact: ConsultationArtifact): Promise<void>;
  findArtifact(followupId: string, path: string, commitSha: string): Promise<ConsultationArtifact | null>;
  listArtifacts(consultationId: string): Promise<ConsultationArtifact[]>;
}

/**
 * 相談の所属scope（Organizationが所有）の状態と、参照として受け付けるProject ResourceのID。
 * Workspace scopeはWorkspace自身の状態で、Project Resourceは参照できない（`resourceIds`は空）。
 */
export type ConsultationScopeState = { workspaceId: string; archived: boolean; resourceIds: string[] };

/** 相談が読む他Contextの状態。Collaborationはworkspace・project・task・story・intent・outcomeのtableを直接読まない。 */
export interface ConsultationScopeReader {
  /** 存在しないProject・Workspaceはnull。 */
  findScope(scope: ConsultationScope): Promise<ConsultationScopeState | null>;
  /** Task・Story（Workが所有）がそのProjectに存在するか。 */
  workItemExists(projectId: string, kind: "task" | "story", id: string): Promise<boolean>;
  /** Intent・Outcome（Directionが所有）がそのWorkspaceに存在するか。Outcomeは所属Intentも一致すること。 */
  directionItemExists(workspaceId: string, reference: Extract<ConsultationReference, { kind: "intent" | "outcome" }>): Promise<boolean>;
}

/** 文書反映Task（Workが所有）。 */
export type FollowupTaskState = { id: string; title: string; status: FollowupTaskStatus };

/** Projectに登録されたRepository（Organizationが所有）。 */
export type FollowupRepository = { id: string; name: string; url: string };

/** 反映担当Project（Organizationが所有）。 */
export type FollowupProject = { id: string; name: string };

/** 文書反映Taskの受入成果物（Workの受入証跡）。受け入れたManagerが確認したRepository・commit・path・PRの参照。 */
export type FollowupAcceptedDeliverable = { repositoryId: string; commitSha: string; paths: string[]; pullRequestUrl: string | null };

/** 相談を待つTask（Workの待機関係）。元Taskの状態を相談から辿るために読む。 */
export type ConsultationWaitingTask = {
  taskId: string;
  title: string;
  status: FollowupTaskStatus;
  phase: "work" | "review" | "acceptance";
  state: "waiting" | "ready" | "resuming";
  failureReason: string | null;
};

/** 文書反映の意味的な履歴（Activityが所有）。本文は持たず、要約と参照だけを記録する。 */
export type FollowupActivityFact = {
  type: "consultation.followup_requested" | "consultation.followup_reflected";
  projectId: string;
  actor: ConsultationActor;
  summary: string;
  consultationId: string;
  /** 相談のscope。Workspace相談はWorkspaceの相談詳細へ辿る参照にする。 */
  consultationScope: ConsultationScope["kind"];
  taskId: string;
  artifact: { repositoryId: string; path: string; commitSha: string; pullRequestUrl: string | null } | null;
  occurredAt: number;
};

/**
 * 文書反映が使う他Contextの操作。Task（Work）の起票は既存の起票処理（Grant・Projectの状態・受付記録・Change Log・canonical Activity）を
 * 相談の記録と同じtransactionで行い、Collaborationはtask・project_repository等のtableを直接扱わない。
 */
export interface ConsultationFollowupLinks {
  /** 呼出しPrincipal・RoleのProject Grantで、通常のWork Taskを起票する。 */
  issueTask(actor: ConsultationActor, input: { projectId: string; storyId: string | null; title: string; description: string }, requestId: string): Promise<{ id: string }>;
  /** そのProjectのTask（別Projectのタスクはnull）。 */
  findTask(projectId: string, taskId: string): Promise<FollowupTaskState | null>;
  /** そのProjectのTaskの最新の受入で残した受入成果物（未受入・成果物なしは空）。 */
  findAcceptedDeliverables(projectId: string, taskId: string): Promise<FollowupAcceptedDeliverable[]>;
  findProject(projectId: string): Promise<FollowupProject | null>;
  /** そのProjectに登録されたRepository（未登録・別ProjectのRepositoryはnull）。 */
  findRepository(projectId: string, repositoryId: string): Promise<FollowupRepository | null>;
  /** その相談を待つ同じProjectのTask。 */
  listWaitingTasks(projectId: string, consultationId: string): Promise<ConsultationWaitingTask[]>;
  recordActivity(fact: FollowupActivityFact): Promise<void>;
}

/** 相談の照合・追記・受付記録と、他Contextの状態の読取り・文書反映Taskの起票を同じtransactionで行う。 */
export interface ConsultationUnitOfWork {
  execute<T>(work: (store: ConsultationStore, scopes: ConsultationScopeReader, links: ConsultationFollowupLinks) => Promise<T>): Promise<T>;
}

/**
 * Agentの認可（Accessが所有）。serverがscopeのRole Grantで実装し、Project scopeはExecution Role（manager / worker / reviewer）、
 * Workspace scopeはDirection Role（strategist / researcher / evaluator）だけで認可する。WorkspaceとProjectの間・他scopeのGrantを継承しない。
 * activeRole（`X-Compass-Active-Role`）の指定時はそのRoleだけで認可する。
 */
export interface ConsultationAgentAuthorization {
  /** scopeのRoleのいずれかのGrant（activeRoleの指定時はそのRole）を要求し、Principalを返す。 */
  requireReader(principal: string | null, scope: ConsultationScope): Promise<string>;
  /** 記録するRoleを決める。`role`の指定時はそのGrantを要求し、未指定ならactiveRole、どちらも無ければnull。 */
  resolveActor(principal: string | null, scope: ConsultationScope, role: string | undefined): Promise<ConsultationActor | null>;
  /** 結論整理・取消を担うRole（ProjectはManager、WorkspaceはStrategist）のGrantを要求する。 */
  requireResponder(principal: string | null, scope: ConsultationScope): Promise<ConsultationActor>;
  /** 文書反映の依頼・成果物参照の登録を行う、反映担当ProjectのmanagerのGrantを要求する（相談のscopeによらない）。 */
  requireProjectManager(principal: string | null, projectId: string): Promise<ConsultationActor>;
}
