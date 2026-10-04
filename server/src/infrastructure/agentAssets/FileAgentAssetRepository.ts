import { execFile } from "node:child_process";
import { readdir, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
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

const run = promisify(execFile);

/** 構成資産を置くrepo直下のdirectory。Git revisionと未commit変更はこの範囲で判定する。 */
export const agentAssetDirectories = ["roles", "policies", "skills", "knowledge"] as const;

const defaultAssetRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const toolIdentifier = /^[a-z][a-z0-9-]*:[a-z][a-z0-9_]*$/;
/** knowledge/配下の相対path。`..`・絶対pathでknowledge外のfileを開かせない。 */
const knowledgeName = /^[\w-]+(?:\/[\w-]+)*\.md$/;

const reasonOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

const readAsset = async (root: string, path: string) => {
  try {
    return await readFile(join(root, path), "utf-8");
  } catch (error) {
    throw new InstructionUnavailableError(path, reasonOf(error));
  }
};

const listMarkdown = async (root: string, directory: string) => {
  try {
    return (await readdir(join(root, directory))).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    throw new InstructionUnavailableError(`${directory}/`, reasonOf(error));
  }
};

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

/**
 * repo直下の`roles/`・`policies/`・`skills/`・`knowledge/`をfileから読む。本文はコードへ埋め込まない。
 * Roleを追加するときは、ProjectRoleと`roles/<role>.md`を足せば同じ経路で配信される。
 */
export class FileAgentAssetRepository implements AgentAssetRepository {
  /** 読み込み元。既定はrepo直下。欠落・不正時の挙動をtestするために差し替えられる。 */
  constructor(private readonly root: string = defaultAssetRoot) {}

  async getRole(role: ProjectRole): Promise<RoleDefinition> {
    const path = `roles/${role}.md`;
    // 列挙した名前だけを読む。runtimeで型が守られない入力でも、roles外のfileは開かない。
    if (!(projectRoles as readonly string[]).includes(role)) {
      throw new InstructionUnavailableError(path, "unknown role");
    }
    const raw = await readAsset(this.root, path);
    const { data, content } = parse(path, raw);
    return { role, path, raw, content, skills: stringList(path, "skills", data.skills) };
  }

  async getPolicy(name: string): Promise<PolicyDocument> {
    const path = `policies/${name}.md`;
    if (!/^[\w-]+$/.test(name)) throw new InstructionUnavailableError(path, "invalid policy name");
    return { name, path, content: await readAsset(this.root, path) };
  }

  async listSkills(): Promise<Skill[]> {
    const files = await listMarkdown(this.root, "skills");
    return Promise.all(files.map((file) => this.readSkill(`skills/${file}`, file.slice(0, -".md".length))));
  }

  async getKnowledge(name: string): Promise<KnowledgeDocument> {
    const path = `knowledge/${name}`;
    if (!knowledgeName.test(name)) throw new InstructionUnavailableError(path, "invalid knowledge path");
    return { name, path, content: await readAsset(this.root, path) };
  }

  /** HEADと構成資産の未commit変更。Git管理外・gitが使えない場合はnull（推測で埋めない）。 */
  async getSource(): Promise<AgentAssetSource> {
    try {
      const git = (...args: string[]) => run("git", args, { cwd: this.root, timeout: 5_000 });
      // 別repoの中のdirectoryを読んでいる場合に、無関係なrevisionを返さない。
      const topLevel = (await git("rev-parse", "--show-toplevel")).stdout.trim();
      if ((await realpath(topLevel)) !== (await realpath(this.root))) return { revision: null, dirty: null };
      const revision = (await git("rev-parse", "HEAD")).stdout.trim();
      const status = (await git("status", "--porcelain", "--", ...agentAssetDirectories)).stdout.trim();
      return { revision, dirty: status !== "" };
    } catch {
      return { revision: null, dirty: null };
    }
  }

  private async readSkill(path: string, fileName: string): Promise<Skill> {
    const { data, content } = parse(path, await readAsset(this.root, path));
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
