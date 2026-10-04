import type { ProjectRole } from "@compass/access";

/**
 * Agentを構成するGit管理の資産（roles/・policies/・skills/・knowledge/）。実行システムのコードではなく、
 * Serverが必要時にMCPで配信する。Skillは認可を担わず、Role→Skillの一方向参照だけを持つ。
 */

/** 配信した資産の版。再現性の正本はGit revision。Git管理外・取得失敗はnull。 */
export type AgentAssetSource = {
  /** 資産を読んだ作業treeのHEAD commit。 */
  revision: string | null;
  /** roles/・policies/・skills/・knowledge/に未commitの変更があるか。trueならrevisionだけでは再現できない。 */
  dirty: boolean | null;
};

export type RoleDefinition = {
  role: ProjectRole;
  /** repo相対path（例: roles/worker.md）。 */
  path: string;
  /** frontmatterを含むfile全体。`get_role_instructions`の互換応答に使う。 */
  raw: string;
  /** frontmatterを除いた本文。 */
  content: string;
  /** このRoleが使うSkill名。Skill側はRoleを知らない。 */
  skills: string[];
};

export type PolicyDocument = {
  name: string;
  path: string;
  content: string;
};

export const SkillStatus = {
  DRAFT: "draft",
  ACTIVE: "active",
  DEPRECATED: "deprecated",
} as const;

export type SkillStatus = (typeof SkillStatus)[keyof typeof SkillStatus];

export const skillStatuses = Object.values(SkillStatus) as [SkillStatus, ...SkillStatus[]];

/** Skillの機械可読なmetadata。本文はJITで`get_skill_context`から取得する。 */
export type SkillMetadata = {
  name: string;
  description: string;
  status: SkillStatus;
  /** 人間向けの版。再現性の正本はGit revision。 */
  version: number;
  path: string;
  /** knowledge/からの相対path。 */
  requiredKnowledge: string[];
  /** namespace付きTool識別子（例: compass:claim_task）。 */
  requiredTools: string[];
};

export type Skill = SkillMetadata & { content: string };

export type KnowledgeDocument = {
  /** knowledge/からの相対path（SkillのrequiredKnowledgeと同じ表記）。 */
  name: string;
  path: string;
  content: string;
};

/** 構成資産の読込port。実装はinfrastructure（file・Git）にあり、欠落・不正はInstructionUnavailableErrorにする。 */
export interface AgentAssetRepository {
  getRole(role: ProjectRole): Promise<RoleDefinition>;
  getPolicy(name: string): Promise<PolicyDocument>;
  listSkills(): Promise<Skill[]>;
  getKnowledge(name: string): Promise<KnowledgeDocument>;
  getSource(): Promise<AgentAssetSource>;
}
