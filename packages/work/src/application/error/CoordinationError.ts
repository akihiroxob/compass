/** Execution（旧Wacha）のTask / Claim操作が返すエラーコード。旧Wachaの契約をそのまま維持する。 */
export type CoordinationErrorCode =
  | "CLAIM_CONFLICT"
  | "CLAIM_NOT_FOUND"
  | "CLAIM_NOT_OWNED"
  | "CLAIM_EXPIRED"
  | "TASK_NOT_CLAIMABLE"
  | "INVALID_INPUT"
  | "INVALID_TASK_STATUS"
  | "FORBIDDEN"
  | "SELF_REVIEW_NOT_ALLOWED"
  | "SELF_ACCEPTANCE_NOT_ALLOWED"
  | "INVALID_FILTER_COMBINATION"
  | "IDEMPOTENCY_CONFLICT"
  /** GitHubの事実を確認できなかった（応答なし・timeout・rate limit・5xx・不正な応答）。何も記録していない。同じ入力で再送できる。 */
  | "GITHUB_UNAVAILABLE"
  /** GitHubが認証・権限の不足で拒否した。設定が変わるまで再送しても成功しない。 */
  | "GITHUB_ACCESS_DENIED"
  /** GitHubにそのRepository・PRが無い、または見えない。 */
  | "PULL_REQUEST_NOT_FOUND"
  /** PRの事実が登録の条件（Repository・open・draftでない・他Task未登録等）を満たさない。 */
  | "PULL_REQUEST_NOT_READY";

const retryableCodes = new Set<CoordinationErrorCode>(["CLAIM_CONFLICT", "GITHUB_UNAVAILABLE"]);

export class CoordinationError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: CoordinationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "CoordinationError";
    this.retryable = retryableCodes.has(code);
  }

  toJSON() {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
    };
  }
}
