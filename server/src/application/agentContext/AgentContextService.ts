import type { ProjectRole } from "@compass/access";
import { NotFoundError } from "@compass/shared";
import type {
  AgentAssetRepository,
  AgentAssetSource,
  KnowledgeDocument,
  PolicyDocument,
  RoleDefinition,
  Skill,
  SkillMetadata,
  SkillStatus,
} from "./AgentAssets.ts";
import { InstructionUnavailableError } from "./InstructionUnavailableError.ts";

export type InstructionFile = { path: string; kind: "shared" | "role"; content: string };

export type RoleInstructions = { role: ProjectRole; includeShared: boolean; files: InstructionFile[] };

/** すべてのRoleに適用するPolicy。`get_role_instructions`の`includeShared`もこの順で先頭に返す。 */
export const sharedPolicyNames = ["role-policy"] as const;

export type RoleAssets = {
  role: Omit<RoleDefinition, "raw" | "role"> & { name: ProjectRole };
  policies: PolicyDocument[];
  skills: SkillMetadata[];
  source: AgentAssetSource;
};

const metadataOf = ({ content: _content, ...metadata }: Skill): SkillMetadata => metadata;

/**
 * Role・Policy・Skill・Knowledgeの配信（Progressive Disclosure）。Roleの起動時はRoleと適用Policy・Skill metadataだけを返し、
 * Skill本文とrequiredKnowledgeは`getSkillContext`でJITに返す。Skillによる認可はしない（認可はAccess）。
 * 片方でも読めなければ、部分的な応答を返さずにInstructionUnavailableErrorで失敗する。
 */
export class AgentContextService {
  constructor(private readonly assets: AgentAssetRepository) {}

  /** 互換の`get_role_instructions`。`includeShared`のときだけ共通Policyを先頭に含める。 */
  async getRoleInstructions(role: ProjectRole, includeShared = false): Promise<RoleInstructions> {
    const files: InstructionFile[] = [];
    if (includeShared) {
      for (const policy of await this.policies()) files.push({ path: policy.path, kind: "shared", content: policy.content });
    }
    const definition = await this.assets.getRole(role);
    files.push({ path: definition.path, kind: "role", content: definition.raw });
    return { role, includeShared, files };
  }

  /** Role Definition・適用Policy・Roleが参照するSkillのmetadata。Skill本文・Knowledge本文は含めない。 */
  async getRoleAssets(role: ProjectRole): Promise<RoleAssets> {
    const definition = await this.assets.getRole(role);
    const skills = await this.assets.listSkills();
    const referenced = definition.skills.map((name) => {
      const skill = skills.find((candidate) => candidate.name === name);
      if (!skill) throw new InstructionUnavailableError(definition.path, `unknown skill ${name}`);
      return metadataOf(skill);
    });
    const { raw: _raw, role: name, ...rest } = definition;
    return {
      role: { name, ...rest },
      policies: await this.policies(),
      skills: referenced,
      source: await this.assets.getSource(),
    };
  }

  /** Skillのmetadata一覧（名前順）。roleの指定時は、そのRoleが参照するSkillだけ。 */
  async listSkills(filter: { status?: SkillStatus; role?: ProjectRole } = {}) {
    const allowed = filter.role === undefined ? null : new Set((await this.assets.getRole(filter.role)).skills);
    const skills = (await this.assets.listSkills())
      .filter((skill) => (filter.status === undefined ? true : skill.status === filter.status))
      .filter((skill) => (allowed === null ? true : allowed.has(skill.name)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(metadataOf);
    return { skills, source: await this.assets.getSource() };
  }

  /** Skill本文とrequiredKnowledgeの本文。未知のSkillはNOT_FOUND、Knowledgeの欠落はINSTRUCTION_UNAVAILABLE。 */
  async getSkillContext(name: string): Promise<{ skill: Skill; knowledge: KnowledgeDocument[]; source: AgentAssetSource }> {
    const skill = (await this.assets.listSkills()).find((candidate) => candidate.name === name);
    if (!skill) throw new NotFoundError(`Skill ${name} was not found`);
    const knowledge: KnowledgeDocument[] = [];
    for (const path of skill.requiredKnowledge) knowledge.push(await this.assets.getKnowledge(path));
    return { skill, knowledge, source: await this.assets.getSource() };
  }

  private async policies() {
    const policies: PolicyDocument[] = [];
    for (const name of sharedPolicyNames) policies.push(await this.assets.getPolicy(name));
    return policies;
  }
}
