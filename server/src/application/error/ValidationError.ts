export class ValidationError extends Error {
  readonly code = "VALIDATION_ERROR";

  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message);
    this.name = "ValidationError";
  }
}
