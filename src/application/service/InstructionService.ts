import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { projectRoles, type ProjectRole } from "../../constants/ProjectRole.ts";
import { InstructionUnavailableError } from "../error/InstructionUnavailableError.ts";

export type InstructionName = ProjectRole | "role-policy";

export type InstructionFile = { path: string; kind: "shared" | "role"; content: string };

export type RoleInstructions = { role: ProjectRole; includeShared: boolean; files: InstructionFile[] };

const sharedInstructionName = "role-policy";
const instructionNames: readonly string[] = [sharedInstructionName, ...projectRoles];
const defaultInstructionRoot = fileURLToPath(new URL("../../../agent", import.meta.url));

/**
 * Role Instruction（repo直下の agent/<name>.md）の配信。本文はコードへ埋め込まない。
 * Roleを追加するときは、ProjectRoleとagent/<role>.mdを足せば同じ経路で配信される。
 */
export class InstructionService {
  /** 読み込み元。既定はrepo直下のagent。欠落時の挙動をtestするために差し替えられる。 */
  constructor(private readonly instructionRoot: string = defaultInstructionRoot) {}

  async getInstructionContent(instructionName: InstructionName): Promise<string> {
    const path = `agent/${instructionName}.md`;
    // 列挙した名前だけを読む。runtimeで型が守られない入力でも、agent外のfileは開かない。
    if (!instructionNames.includes(instructionName)) {
      throw new InstructionUnavailableError(path, "unknown instruction name");
    }
    try {
      return await readFile(`${this.instructionRoot}/${instructionName}.md`, "utf-8");
    } catch (error) {
      throw new InstructionUnavailableError(path, error instanceof Error ? error.message : String(error));
    }
  }

  /** `includeShared` のときだけ共通Policyを先頭に含める。片方でも読めなければ、部分的な応答を返さずに失敗する。 */
  async getRoleInstructions(role: ProjectRole, includeShared = false): Promise<RoleInstructions> {
    const files: InstructionFile[] = [];
    if (includeShared) {
      files.push({
        path: `agent/${sharedInstructionName}.md`,
        kind: "shared",
        content: await this.getInstructionContent(sharedInstructionName),
      });
    }
    files.push({ path: `agent/${role}.md`, kind: "role", content: await this.getInstructionContent(role) });
    return { role, includeShared, files };
  }
}
