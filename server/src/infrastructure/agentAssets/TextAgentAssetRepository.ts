import { projectRoles, type ProjectRole } from "@compass/access";
import {
  skillStatuses,
  SkillStatus,
  type AgentAssetRepository,
  type AgentAssetSource,
  type KnowledgeDocument,
  type PolicyDocument,
  type RoleDefinition,
  type Skill,
} from "../../application/agentContext/AgentAssets.ts";
import { InstructionUnavailableError } from "../../application/agentContext/InstructionUnavailableError.ts";
import { parseFrontmatter, type FrontmatterValue } from "./frontmatter.ts";


export interface AgentAssetTextSource {
  read(path: string): Promise<string>;
  /** skills/直下のMarkdownファイル名。 */
  listSkills(): Promise<string[]>;
  revision(): string | null | undefined;
}

const toolIdentifier = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;
/** knowledge/配下の相対path。`..`・絶対pathでknowledge外のfileを開かせない。 */
const knowledgeName = /^[\w-]+(?:\/[\w-]+)*\.md$/;

const reasonOf = (error: unknown) => error instanceof Error ? error.message : String(error);

const parse = (path: string, text: string) => {
  try {
    return parseFrontmatter(text);
  } catch (error) {
    throw new InstructionUnavailableError(path, reasonOf(error));
  }
};

const stringList = (path: string, key: string, value: FrontmatterValue | undefined) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new InstructionUnavailableError(path, `${key} must be a list`);
  return value;
};

/** 配信元によらず、Agent資産の名前・frontmatter・参照形式を検証する。 */
export class TextAgentAssetRepository implements AgentAssetRepository {
  constructor(private readonly source: AgentAssetTextSource) {}

  async getRole(role: ProjectRole): Promise<RoleDefinition> {
    const path = `roles/${role}.md`;
    // 列挙した名前だけを読む。runtimeで型が守られない入力でも、roles外のfileは開かない。
    if (!(projectRoles as readonly string[]).includes(role)) {
      throw new InstructionUnavailableError(path, "unknown role");
    }
    const raw = await this.source.read(path);
    const { data, content } = parse(path, raw);
    return { role, path, raw, content, skills: stringList(path, "skills", data.skills) };
  }

  async getPolicy(name: string): Promise<PolicyDocument> {
    const path = `policies/${name}.md`;
    if (!/^[\w-]+$/.test(name)) throw new InstructionUnavailableError(path, "invalid policy name");
    return { name, path, content: await this.source.read(path) };
  }

  async listSkills(): Promise<Skill[]> {
    const files = await this.source.listSkills();
    return Promise.all(files.map((file) => this.readSkill(`skills/${file}`, file.slice(0, -".md".length))));
  }

  async getKnowledge(name: string): Promise<KnowledgeDocument> {
    const path = `knowledge/${name}`;
    if (!knowledgeName.test(name)) throw new InstructionUnavailableError(path, "invalid knowledge path");
    return { name, path, content: await this.source.read(path) };
  }

  /** デプロイ時に指定されたCompassのcommit SHA。未指定・不正値は不明として扱う。 */
  async getSource(): Promise<AgentAssetSource> {
    const revision = this.source.revision();
    return { revision: revision && /^[a-f0-9]{40}$/i.test(revision) ? revision : null };
  }

  private async readSkill(path: string, fileName: string): Promise<Skill> {
    const { data, content } = parse(path, await this.source.read(path));
    // Skillは認可を担わない。Roleとの対応はroles/<role>.mdのskillsだけで表す。
    if ("allowRoles" in data) {
      throw new InstructionUnavailableError(path, "allowRoles is not supported; reference the Skill from roles/<role>.md");
    }
    if (data.name !== fileName) throw new InstructionUnavailableError(path, "name must match the file name");
    if (typeof data.description !== "string" || data.description === "") {
      throw new InstructionUnavailableError(path, "description is required");
    }
    const status = data.status ?? SkillStatus.DRAFT;
    if (!(skillStatuses as readonly unknown[]).includes(status)) {
      throw new InstructionUnavailableError(path, `unknown status ${String(status)}`);
    }
    const version = data.version ?? 1;
    if (typeof version !== "number") throw new InstructionUnavailableError(path, "version must be a number");
    const requiredTools = stringList(path, "requiredTools", data.requiredTools);
    const unnamespaced = requiredTools.filter((tool) => !toolIdentifier.test(tool));
    if (unnamespaced.length > 0) {
      throw new InstructionUnavailableError(path, `requiredTools must be namespaced (e.g. compass:list_tasks): ${unnamespaced.join(", ")}`);
    }
    return {
      name: fileName,
      description: data.description,
      status: status as SkillStatus,
      version,
      path,
      requiredKnowledge: stringList(path, "requiredKnowledge", data.requiredKnowledge),
      requiredTools,
      content,
    };
  }
}
