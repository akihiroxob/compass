import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { projectRoles } from "@compass/access";
import { BundledAgentAssetRepository } from "../src/infrastructure/agentAssets/BundledAgentAssetRepository.ts";
import { FileAgentAssetRepository } from "../src/infrastructure/agentAssets/FileAgentAssetRepository.ts";

const root = new URL("../../", import.meta.url);
const documents: Record<string, string> = {};
const collect = async (directory: string) => {
  for (const entry of await readdir(new URL(directory, root), { withFileTypes: true })) {
    const path = `${directory}${entry.name}`;
    if (entry.isDirectory()) await collect(`${path}/`);
    else if (entry.name.endsWith(".md")) documents[path] = await readFile(new URL(path, root), "utf8");
  }
};
for (const directory of ["roles/", "policies/", "skills/", "knowledge/"]) await collect(directory);

test("bundled assets and filesystem assets use the same content and metadata contracts", async () => {
  const bundled = new BundledAgentAssetRepository(documents);
  const files = new FileAgentAssetRepository(fileURLToPath(root));
  for (const role of projectRoles) assert.deepEqual(await bundled.getRole(role), await files.getRole(role));
  assert.deepEqual(await bundled.listSkills(), await files.listSkills());
  for (const path of Object.keys(documents)) {
    if (path.startsWith("knowledge/")) {
      const name = path.slice("knowledge/".length);
      assert.deepEqual(await bundled.getKnowledge(name), await files.getKnowledge(name));
    }
    if (path.startsWith("policies/")) {
      const name = path.slice("policies/".length, -3);
      assert.deepEqual(await bundled.getPolicy(name), await files.getPolicy(name));
    }
  }
});

test("bundled assets reject missing, invalid and traversal inputs and keep a deployment snapshot", async () => {
  const mutable = { "policies/test.md": "deployed policy" };
  const repository = new BundledAgentAssetRepository(mutable, "a".repeat(40));
  mutable["policies/test.md"] = "changed after deployment";
  assert.equal((await repository.getPolicy("test")).content, "deployed policy");
  assert.deepEqual(await repository.getSource(), { revision: "a".repeat(40) });
  assert.deepEqual(await new BundledAgentAssetRepository({}, "invalid").getSource(), { revision: null });
  for (const operation of [repository.getKnowledge("../policies/test.md"), repository.getPolicy("../test"), repository.getPolicy("missing")]) {
    await assert.rejects(operation, { code: "INSTRUCTION_UNAVAILABLE" });
  }
  const invalid = new BundledAgentAssetRepository({ "skills/bad.md": "---\nname: bad\ndescription: Invalid\nrequiredTools:\n  - list_tasks\n---\nbody" });
  await assert.rejects(invalid.listSkills(), { code: "INSTRUCTION_UNAVAILABLE" });
});
