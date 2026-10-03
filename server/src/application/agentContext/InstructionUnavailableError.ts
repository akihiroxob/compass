/** Role・Policy・Skill・Knowledgeの構成資産を読めない・形式が不正。部分的な応答を返さずに失敗させる。 */
export class InstructionUnavailableError extends Error {
  readonly code = "INSTRUCTION_UNAVAILABLE";

  constructor(
    /** 読めなかった構成資産のrepo相対path（例: roles/strategist.md）。 */
    readonly path: string,
    reason: string,
  ) {
    super(`Failed to load instruction ${path}: ${reason}`);
    this.name = "InstructionUnavailableError";
  }
}
