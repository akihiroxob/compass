import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readlinkSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** 保存済みworktreeを変更せず、未commit・未追跡成果物とContextを含む現在版を読む。 */
export function inspectConsultationRuntime(saved) {
  const worktreePath = resolve(saved.worktreePath);
  const contextPath = resolve(saved.contextPath);
  if (!existsSync(contextPath)) throw new Error(`Saved Context is missing: ${contextPath}`);
  const git = (...args) => execFileSync("git", ["-C", worktreePath, ...args], { maxBuffer: 64 * 1024 * 1024 });
  const headSha = git("rev-parse", "HEAD").toString().trim();
  const hash = createHash("sha256");
  hash.update(git("diff", "--binary", "HEAD", "--"));
  hash.update(git("diff", "--cached", "--binary", "--"));
  const paths = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean).sort();
  for (const path of paths) {
    if (path.startsWith(".compass-ralph/") || path === ".ralph-result.json" || resolve(worktreePath, path) === contextPath) continue;
    const absolute = resolve(worktreePath, path);
    hash.update(path).update("\0");
    const stat = lstatSync(absolute);
    hash.update(String(stat.mode));
    hash.update(stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute));
  }
  hash.update(readFileSync(contextPath));
  return { worktreePath, contextPath, headSha, sourceFingerprint: hash.digest("hex"),
    pullRequest: saved.pullRequest ?? null, verificationRefs: saved.verificationRefs ?? [] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const saved = JSON.parse(readFileSync(process.argv[2], "utf8"));
  console.log(JSON.stringify(inspectConsultationRuntime(saved)));
}
