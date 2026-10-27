import { ConflictError, inputHash, NotFoundError } from "@compass/shared";
import type { Consultation, ConsultationActor, ConsultationScope, ConsultationViolation } from "../domain/Consultation.ts";
import type { ConsultationScopeReader, ConsultationStore } from "./port/ConsultationStore.ts";

/** 相談のuse caseが共有する照合・受付記録。package外へは公開しない。 */

export type Clock = () => number;

const violationMessages: Record<ConsultationViolation, string> = {
  CONSULTATION_CLOSED: "The Consultation is already resolved or canceled; start a new Consultation that supersedes it",
  NOT_WAITING_AGENT: "The Consultation is not waiting for an Agent response",
  STALE_REVISION: "The Consultation has changed since the given revision; read it again",
  LEASE_HELD: "Another Agent holds the response lease for this revision",
  LEASE_NOT_HELD: "The response lease is not held by the caller or was already used",
  LEASE_EXPIRED: "The response lease has expired; acquire a new lease",
  SUPERSEDED_NOT_CLOSED: "Only a resolved or canceled Consultation can be superseded; continue the open Consultation instead",
};

export const violation = (code: ConsultationViolation, consultation: Pick<Consultation, "id" | "revision" | "status">) =>
  new ConflictError(violationMessages[code], {
    conflict: code,
    consultationId: consultation.id,
    currentRevision: String(consultation.revision),
    consultationStatus: consultation.status,
  });

export const consultationNotFound = (consultationId: string) => new NotFoundError(`Consultation ${consultationId} was not found`);

const scopeLabel = (scope: ConsultationScope) => (scope.kind === "project" ? `Project ${scope.projectId}` : `Workspace ${scope.workspaceId}`);

/** scopeのProject・Workspaceの存在（無ければ404）。 */
export const requireScope = async (scopes: ConsultationScopeReader, scope: ConsultationScope) => {
  const state = await scopes.findScope(scope);
  if (!state) throw new NotFoundError(`${scopeLabel(scope)} was not found`);
  return state;
};

/** 書込の前提。scopeのProject・Workspaceの存在（無ければ404）とarchived（409）を、書込と同じtransactionで確かめる。 */
export const requireWritableScope = async (scopes: ConsultationScopeReader, scope: ConsultationScope) => {
  const state = await requireScope(scopes, scope);
  if (state.archived) {
    throw new ConflictError(`${scopeLabel(scope)} is archived and can no longer be changed`, scope.kind === "project" ? { projectStatus: "archived" } : { workspaceStatus: "archived" });
  }
  return state;
};

export const requireConsultation = async (store: ConsultationStore, scope: ConsultationScope, consultationId: string) => {
  const consultation = await store.findConsultation(scope, consultationId);
  if (!consultation) throw consultationNotFound(consultationId);
  return consultation;
};

/**
 * `requestId`の受付記録。同じ主体・操作・`requestId`の再送は、状態がその後変わっていても保存済みの結果を返し、
 * 別の内容での再利用は`CONFLICT`にする。照合は状態の検査より先に行い、通信断後の再送で重複・誤拒否を起こさない。
 */
export const withReceipt = async <T>(
  store: ConsultationStore,
  actor: ConsultationActor,
  operation: string,
  requestId: string,
  input: unknown,
  clock: Clock,
  run: () => Promise<T>,
): Promise<T> => {
  const hash = inputHash({ input, role: actor.role });
  const saved = await store.findReceipt(actor.principalId, operation, requestId);
  if (saved) {
    if (saved.inputHash !== hash) {
      throw new ConflictError(`requestId ${requestId} was already used for a different ${operation} request`, { conflict: "IDEMPOTENCY_CONFLICT" });
    }
    return saved.result as T;
  }
  const result = await run();
  await store.insertReceipt({ principalId: actor.principalId, operation, requestId, inputHash: hash, result, createdAt: clock() });
  return result;
};
