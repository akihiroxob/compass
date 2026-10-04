export class ConflictError extends Error {
  readonly code = "CONFLICT";

  constructor(
    message: string,
    /** 呼び出し側が競合の相手を辿るための付加情報（例: activeIntentId）。 */
    readonly details: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ConflictError";
  }
}
