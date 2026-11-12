import { readdir, readFile, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, relative, sep } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const documents = {};
const collect = async (directory) => {
  for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await collect(path);
    else if (entry.isFile() && entry.name.endsWith(".md")) documents[relative(root, path).split(sep).join("/")] = await readFile(path, "utf8");
  }
};
for (const directory of ["roles", "skills", "policies", "knowledge"]) await collect(join(root, directory));
const value = process.env.COMPASS_DEPLOY_REVISION ?? process.env.WORKERS_CI_COMMIT_SHA;
const revision = value && /^[a-f0-9]{40}$/i.test(value) ? value : null;
const output = join(root, "server/.generated");
await mkdir(output, { recursive: true });
await writeFile(join(output, "agent-assets.mjs"), `export const documents = ${JSON.stringify(documents)};\nexport const revision = ${JSON.stringify(revision)};\n`);
await writeFile(join(output, "worker.mjs"), 'import { createWorker } from "../src/worker.ts";\nimport { documents, revision } from "./agent-assets.mjs";\nexport default createWorker(documents, revision);\n');
console.log(`Prepared ${Object.keys(documents).length} deployed Agent documents`);
