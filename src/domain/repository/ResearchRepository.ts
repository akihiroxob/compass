import type { IntentStatus } from "../model/Intent.ts";
import type {
  EvidenceReference,
  ResearchFinding,
  ResearchRequest,
  ResearchRequestDetail,
  ResearchRequestStatus,
  ResearchResult,
  ResearchSynthesis,
} from "../model/Research.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";
import type {
  CompleteResearchRequestInput,
  CreateResearchRequestInput,
  RegisterResearchResultInput,
  RegisterResearchSynthesisInput,
} from "../../shared/researchSchema.ts";

/** 同じrequestKeyで内容の異なる操作が来た結果。再送（同じ内容）は`replayed`として既存を返す。 */
export type ResearchKeyConflictResult = { kind: "key_conflict"; requestKey: string };

/** Request作成の結果。発端のIntent / Outcomeが無い場合と、Intentがactiveでない場合を区別する。 */
export type CreateResearchRequestResult =
  | { kind: "created"; request: ResearchRequest }
  | { kind: "replayed"; request: ResearchRequest }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: IntentStatus }
  | { kind: "outcome_not_found" }
  | { kind: "deadline_in_past"; deadlineAt: number }
  | ResearchKeyConflictResult
  | ProjectArchivedResult;

/** Request配下の書込が共通で返す拒否。 */
type ResearchRequestWriteRejection =
  | { kind: "request_not_found" }
  | { kind: "not_open"; status: ResearchRequestStatus }
  | ResearchKeyConflictResult
  | ProjectArchivedResult;

export type RegisterResearchResultResult =
  | { kind: "registered"; result: ResearchResult }
  | { kind: "replayed"; result: ResearchResult }
  | { kind: "deadline_passed"; deadlineAt: number }
  | { kind: "budget_exceeded"; budgetTotal: number; budgetUsed: number }
  | { kind: "invalid_reference"; reference: "finding"; ids: string[] }
  | ResearchRequestWriteRejection;

export type RegisterResearchSynthesisResult =
  | { kind: "registered"; synthesis: ResearchSynthesis }
  | { kind: "replayed"; synthesis: ResearchSynthesis }
  | { kind: "deadline_passed"; deadlineAt: number }
  | { kind: "invalid_reference"; reference: "finding" | "supersedes"; ids: string[] }
  | { kind: "already_superseded"; supersedesId: string; supersededById: string }
  | ResearchRequestWriteRejection;

/** 終了・取消の結果。`completed`はResultとSynthesisが1件以上ある場合だけ確定できる。 */
export type CloseResearchRequestResult =
  | { kind: "closed"; request: ResearchRequest }
  | { kind: "incomplete"; missing: "result" | "synthesis" }
  | Extract<ResearchRequestWriteRejection, { kind: "request_not_found" | "not_open" | "project_archived" }>;

export type ResearchRequestQuery = {
  originIntentId?: string;
  status?: ResearchRequestStatus;
};

/** Researcherが再利用できる、同じProjectの他Requestが残したFindingと、それが引用するEvidence参照。 */
export type RelatedResearchFindings = {
  findings: ResearchFinding[];
  evidenceRefs: EvidenceReference[];
};

/**
 * Research集約の永続化。Result・Finding・Evidence参照・Synthesisは追記だけで、更新・削除するメソッドは持たない。
 * 書込はすべてProjectのarchived確認と同一transactionで行い、別ProjectのIDは存在しないものとして扱う。
 */
export interface ResearchRepository {
  /** 同じrequestKeyの再送は新しい行を作らず既存のRequestを返す。 */
  createRequest(projectId: string, input: CreateResearchRequestInput): Promise<CreateResearchRequestResult>;
  /** 新しい順。発端Intentや状態で絞れる。 */
  findRequests(projectId: string, query?: ResearchRequestQuery): Promise<ResearchRequest[]>;
  /** 他ProjectのRequest IDはnull。Result・Finding・Evidence・Synthesisを登録順で含める。 */
  findRequestDetail(projectId: string, requestId: string): Promise<ResearchRequestDetail | null>;
  /**
   * 対象Requestと同じ発端Intent（project_watchは発端なし同士）を持つ、同じProjectの他RequestのFindingを新しい順に最大`limit`件返す。
   * 対象Request自身のFindingは含めない（`findRequestDetail`で取得できる）。別Projectのものは返さない。
   */
  findRelatedFindings(projectId: string, requestId: string, limit: number): Promise<RelatedResearchFindings>;
  /** 初回の登録で`requested`から`running`へ進み、使用予算を加算する。期限・予算を超える登録は拒否する。 */
  registerResult(
    projectId: string,
    requestId: string,
    input: RegisterResearchResultInput,
  ): Promise<RegisterResearchResultResult>;
  /** 前versionを`supersedesId`で指す場合は同一Project内の最新versionだけを置き換えられる。 */
  registerSynthesis(
    projectId: string,
    requestId: string,
    input: RegisterResearchSynthesisInput,
  ): Promise<RegisterResearchSynthesisResult>;
  /** completed / insufficient / not_neededのいずれかで終了する。終了済みのRequestは変更しない。 */
  complete(
    projectId: string,
    requestId: string,
    input: CompleteResearchRequestInput,
  ): Promise<CloseResearchRequestResult>;
  cancel(projectId: string, requestId: string, reason: string): Promise<CloseResearchRequestResult>;
}
