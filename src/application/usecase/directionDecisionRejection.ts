import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";
import { ValidationError } from "../error/ValidationError.ts";

/** Decision作成で共通の拒否結果。`created` / `replayed`はそれぞれのuse caseが扱う。 */
type CommonDecisionRejection =
  | { kind: "project_archived" }
  | { kind: "key_conflict"; requestKey: string }
  | { kind: "intent_not_found" }
  | { kind: "intent_not_active"; status: string }
  | { kind: "invalid_reference"; reference: "synthesis" | "finding"; ids: string[] }
  | { kind: "synthesis_version_mismatch"; synthesisId: string; expected: number; actual: number };

/** 共通の拒否結果をアプリケーション層のエラーへ変換する。該当しない結果（created/replayed）は何もしない。 */
export const throwDirectionDecisionRejection = (
  result: { kind: string },
  projectId: string,
  intentId: string,
): void => {
  const rejection = result as CommonDecisionRejection;
  if (rejection.kind === "project_archived") throw new ProjectArchivedError(projectId);
  if (rejection.kind === "intent_not_found") {
    throw new NotFoundError(`Intent ${intentId} was not found in Project ${projectId}`);
  }
  if (rejection.kind === "intent_not_active") {
    throw new ConflictError(
      `Intent ${intentId} is ${rejection.status}; Direction Decisions can only be created for an active Intent`,
      { status: rejection.status },
    );
  }
  if (rejection.kind === "key_conflict") {
    throw new ConflictError(`requestKey ${rejection.requestKey} was already used with different content`, {
      requestKey: rejection.requestKey,
    });
  }
  if (rejection.kind === "invalid_reference") {
    throw new ValidationError("Direction Decision input is invalid", [
      {
        path: rejection.reference === "synthesis" ? "usedSyntheses" : "usedFindingIds",
        message: `unknown ${rejection.reference}: ${rejection.ids.join(", ")}`,
      },
    ]);
  }
  if (rejection.kind === "synthesis_version_mismatch") {
    throw new ConflictError(
      `usedSyntheses references Synthesis ${rejection.synthesisId} at version ${rejection.expected}, but its current version is ${rejection.actual}`,
      {
        synthesisId: rejection.synthesisId,
        expected: String(rejection.expected),
        actual: String(rejection.actual),
      },
    );
  }
};
