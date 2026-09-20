export class InstructionUnavailableError extends Error {
  readonly code = "INSTRUCTION_UNAVAILABLE";

  constructor(
    /** 読めなかったInstructionのrepo相対path（例: agent/strategist.md）。 */
    readonly path: string,
    reason: string,
  ) {
    super(`Failed to load instruction ${path}: ${reason}`);
    this.name = "InstructionUnavailableError";
  }
}
