export class UnauthenticatedError extends Error {
  readonly code = "UNAUTHENTICATED";

  constructor(message = "Authorization: Bearer <AgentName> is required") {
    super(message);
    this.name = "UnauthenticatedError";
  }
}
