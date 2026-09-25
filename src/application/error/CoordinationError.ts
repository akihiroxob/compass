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
  | "IDEMPOTENCY_CONFLICT";

const retryableCodes = new Set<CoordinationErrorCode>(["CLAIM_CONFLICT"]);

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
