export class ForbiddenError extends Error {
  readonly code = "FORBIDDEN";

  constructor(
    message: string,
    /** 呼び出し側が不足を判別できるよう返す。存在しないProjectでも同じ形にし、存在有無を漏らさない。 */
    readonly details: {
      projectId: string;
      /** 不足したRole（Project Role・Human Role）。値はAccessが定義する。 */
      requiredRole?: string;
      /** Runtime Credentialのscope不足・種別違い・別Project（Task 37）。 */
      requiredScope?: string;
    },
  ) {
    super(message);
    this.name = "ForbiddenError";
  }
}
