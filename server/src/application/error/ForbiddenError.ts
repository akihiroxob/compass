import type { ProjectRole } from "../../constants/ProjectRole.ts";
import type { RuntimeScope } from "../../domain/model/AccessCredential.ts";
import type { HumanRole } from "../../domain/model/HumanAuth.ts";

export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";

  constructor(
    message: string,
    /** 呼び出し側が不足を判別できるよう返す。存在しないProjectでも同じ形にし、存在有無を漏らさない。 */
    readonly details: {
      projectId: string;
      requiredRole?: ProjectRole | HumanRole;
      /** Runtime Credentialのscope不足・種別違い・別Project（Task 37）。 */
      requiredScope?: RuntimeScope;
    },
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}
