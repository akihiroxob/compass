import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { InstructionUnavailableError } from "../../application/agentContext/InstructionUnavailableError.ts";
import { TextAgentAssetRepository } from "./TextAgentAssetRepository.ts";

const defaultAssetRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

/** Node開発環境でrepo直下のGit管理資産を読む。 */
export class FileAgentAssetRepository extends TextAgentAssetRepository {
  constructor(root = defaultAssetRoot) {
    super({
      read: async (path) => {
        try {
          return await readFile(join(root, path), "utf-8");
        } catch (error) {
          throw new InstructionUnavailableError(path, reasonOf(error));
        }
      },
      listSkills: async () => {
        try {
          return (await readdir(join(root, "skills"))).filter((file) => file.endsWith(".md")).sort();
        } catch (error) {
          throw new InstructionUnavailableError("skills/", reasonOf(error));
        }
      },
      revision: () => process.env.COMPASS_DEPLOY_REVISION,
    });
  }
}
