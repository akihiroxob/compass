import { ConflictError } from "../error/ConflictError.ts";
import { NotFoundError } from "../error/NotFoundError.ts";
import { ProjectArchivedError } from "../error/ProjectArchivedError.ts";

/** Request配下の書込で共通の拒否結果。それ以外の結果は各use caseが扱う。 */
type CommonRejection =
  | { kind: "request_not_found" }
  | { kind: "not_open"; status: string }
  | { kind: "key_conflict"; requestKey: string }
  | { kind: "project_archived" };

/** 共通の拒否結果をアプリケーション層のエラーへ変換する。該当しない結果は何もしない。 */
export const throwCommonResearchRejection = (
  result: { kind: string },
  projectId: string,
  requestId: string,
): void => {
  const rejection = result as CommonRejection;
  if (rejection.kind === "project_archived") throw new ProjectArchivedError(projectId);
  if (rejection.kind === "request_not_found") {
    throw new NotFoundError(`Research Request ${requestId} was not found in Project ${projectId}`);
  }
  if (rejection.kind === "not_open") {
    throw new ConflictError(
      `Research Request ${requestId} is ${rejection.status}; a closed Research Request can no longer be changed`,
      { status: rejection.status },
    );
  }
  if (rejection.kind === "key_conflict") {
    throw new ConflictError(
      `requestKey ${rejection.requestKey} was already used with different content`,
      { requestKey: rejection.requestKey },
    );
  }
};
