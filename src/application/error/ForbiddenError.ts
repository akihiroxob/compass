import type { ProjectRole } from "../../constants/ProjectRole.ts";
import type { HumanRole } from "../../domain/model/HumanAuth.ts";

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";

  constructor(
    message: string,
    /** 呼び出し側が不足を判別できるよう返す。存在しないProjectでも同じ形にし、存在有無を漏らさない。 */
    readonly details: { requiredRole: ProjectRole | HumanRole; projectId: string },
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}
