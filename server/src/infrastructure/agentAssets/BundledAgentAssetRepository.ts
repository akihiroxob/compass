import { InstructionUnavailableError } from "../../application/agentContext/InstructionUnavailableError.ts";
import { TextAgentAssetRepository } from "./TextAgentAssetRepository.ts";

/** ビルド時に集めたGit管理資産を配信する。実行時のfilesystemやGitには依存しない。 */
export class BundledAgentAssetRepository extends TextAgentAssetRepository {
  constructor(documents: Readonly<Record<string, string>>, revision: string | null = null) {
    // 呼出し元の書換えによって、同じデプロイ内の配信内容を変えない。
    const snapshot = new Map(Object.entries(documents));
    super({
      read: async (path) => {
        const text = snapshot.get(path);
        if (text === undefined) throw new InstructionUnavailableError(path, "asset is not included in this deployment");
        return text;
      },
      listSkills: async () => [...snapshot.keys()]
        .filter((path) => /^skills\/[^/]+\.md$/.test(path))
        .map((path) => path.slice("skills/".length)).sort(),
      revision: () => revision,
    });
  }
}
