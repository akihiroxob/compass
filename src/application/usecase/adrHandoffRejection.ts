import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

/** ADR Handoff Request・ADR Reference作成で共通の拒否結果。`created` / `replayed`はそれぞれのuse caseが扱う。 */
type CommonAdrHandoffRejection =
  | { kind: "project_archived" }
  | { kind: "key_conflict"; requestKey: string }
  | { kind: "decision_not_found" }
  | { kind: "decision_not_adr_candidate"; type: string }
  | { kind: "repository_not_found"; repositoryId: string }
  | { kind: "handoff_request_not_found" };

/** 共通の拒否結果をアプリケーション層のエラーへ変換する。該当しない結果（created/replayed）は何もしない。 */
export const throwAdrHandoffRejection = (result: { kind: string }, projectId: string): void => {
  const rejection = result as CommonAdrHandoffRejection;
  if (rejection.kind === "project_archived") throw new ProjectArchivedError(projectId);
  if (rejection.kind === "decision_not_found") {
    throw new NotFoundError(`Direction Decision was not found in Project ${projectId}`);
  }
  if (rejection.kind === "decision_not_adr_candidate") {
    throw new ConflictError(
      `Direction Decision is type ${rejection.type}; ADR handoff requires an adr_candidate Decision`,
      { type: rejection.type },
    );
  }
  if (rejection.kind === "repository_not_found") {
    throw new NotFoundError(`Repository ${rejection.repositoryId} is not registered in Project ${projectId}`);
  }
  if (rejection.kind === "handoff_request_not_found") {
    throw new ConflictError(
      "No ADR Handoff Request was found for this Decision, Repository and correlationId; " +
        "create the handoff request before recording its result",
    );
  }
  if (rejection.kind === "key_conflict") {
    throw new ConflictError(`requestKey ${rejection.requestKey} was already used with different content`, {
      requestKey: rejection.requestKey,
    });
  }
};
