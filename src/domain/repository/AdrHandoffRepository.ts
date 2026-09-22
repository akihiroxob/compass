import type { AdrHandoffRequest, AdrReference } from "../model/AdrHandoff.ts";
import type { ProjectArchivedResult } from "./ProjectRepository.ts";

export type CreateAdrHandoffRequestInput = {
  decisionId: string;
  repositoryId: string;
  correlationId: string;
  requestKey: string;
  principalId: string;
};

export type RecordAdrReferenceInput = {
  decisionId: string;
  repositoryId: string;
  path: string;
  commitSha: string;
  pullRequestUrl: string | null;
  correlationId: string;
  requestKey: string;
  principalId: string;
};

type CommonAdrHandoffRejection =
  | { kind: "key_conflict"; requestKey: string }
  | { kind: "decision_not_found" }
  | { kind: "decision_not_adr_candidate"; type: string }
  | { kind: "repository_not_found"; repositoryId: string }
  | ProjectArchivedResult;

export type CreateAdrHandoffRequestResult =
  | { kind: "created"; request: AdrHandoffRequest }
  | { kind: "replayed"; request: AdrHandoffRequest }
  | CommonAdrHandoffRejection;

export type RecordAdrReferenceResult =
  | { kind: "created"; reference: AdrReference }
  | { kind: "replayed"; reference: AdrReference }
  | { kind: "handoff_request_not_found" }
  | CommonAdrHandoffRejection;

/**
 * `adr_candidate` Direction Decisionと、対象Repositoryへの技術ADR反映をWachaへ引き渡す契約のfixture永続化。
 * 実Wachaとは未接続で、`createRequest`は依頼payloadを組み立てて保存するだけ、`recordReference`は
 * Wachaが完了させた結果（path / commit SHA / PR URL）を受け取って保存するだけである。どちらもGitHub API等の
 * 外部呼び出しは行わない。
 */
export interface AdrHandoffRepository {
  /**
   * decisionIdが同じProjectの`adr_candidate` Decisionを指し、repositoryIdがそのProjectに登録済みのRepositoryを
   * 指す場合だけpayloadを組み立てて保存する。同じrequestKeyの再送は新しい行を作らず既存の行を返し、
   * 異なる内容の再利用は`key_conflict`で拒否する。
   */
  createRequest(projectId: string, input: CreateAdrHandoffRequestInput): Promise<CreateAdrHandoffRequestResult>;
  /**
   * 同じProject・Decision・Repository・correlationIdの`AdrHandoffRequest`が存在する場合だけ参照を保存する
   * （依頼を経ていない参照を受け付けない）。冪等性の規則は`createRequest`と同じ。
   */
  recordReference(projectId: string, input: RecordAdrReferenceInput): Promise<RecordAdrReferenceResult>;
  /** Project配下の参照を新しい順に返す。 */
  findReferencesByProject(projectId: string): Promise<AdrReference[]>;
}
