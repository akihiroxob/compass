import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../../", import.meta.url));
const inspector = join(root, "ralph/runtime/consultation-context.mjs");
const lock = join(root, "ralph/runtime/worktree-lock.py");

test("保存Context・未commit差分・未追跡成果物の変化を検出し、検査では成果物を変更しない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-resumption-snapshot-"));
  const worktree = join(dir, "worktree");
  try {
    execFileSync("git", ["clone", "--shared", root, worktree], { stdio: "ignore" });
    await mkdir(join(worktree, ".compass-ralph"));
    const contextPath = join(worktree, ".compass-ralph/context.json");
    await writeFile(contextPath, '{"decision":"blocked"}');
    const metadata = join(dir, "runtime.json");
    await writeFile(metadata, JSON.stringify({ worktreePath: worktree, contextPath, pullRequest: "https://example.test/pr/1", verificationRefs: ["old-log@sha"] }));
    const inspect = () => JSON.parse(execFileSync(process.execPath, [inspector, metadata], { encoding: "utf8" }));
    const original = inspect();
    await writeFile(join(worktree, "evidence.txt"), "preserved dirty artifact");
    const dirty = inspect();
    assert.notEqual(dirty.sourceFingerprint, original.sourceFingerprint);
    assert.deepEqual(inspect(), dirty);
    assert.equal(await readFile(join(worktree, "evidence.txt"), "utf8"), "preserved dirty artifact");
    await writeFile(join(worktree, "README.md"), "changed tracked file");
    const changed = inspect();
    assert.notEqual(changed.sourceFingerprint, dirty.sourceFingerprint);
    await writeFile(contextPath, '{"decision":"blocked","moreContext":true}');
    assert.notEqual(inspect().sourceFingerprint, changed.sourceFingerprint);
    assert.deepEqual(inspect().verificationRefs, ["old-log@sha"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("worktree lockは重複起動を拒否し、旧Agentが終了した後だけ次のRunnerへ渡る", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-resumption-lock-"));
  const path = join(dir, "worktree.lock");
  const first = spawn("python3", [lock, path, process.execPath, "-e", "console.log('started'); setTimeout(()=>{}, 5000)"], { stdio: ["ignore", "pipe", "pipe"] });
  const firstExit = new Promise<number | null>((resolve) => first.once("exit", resolve));
  try {
    await new Promise<void>((resolve) => first.stdout!.once("data", () => resolve()));
    const second = spawn("python3", [lock, path, process.execPath, "-e", "process.exit(0)"], { stdio: "ignore" });
    assert.equal(await new Promise((resolve) => second.once("exit", resolve)), 75);
    first.kill("SIGTERM");
    assert.equal(await firstExit, 143);
    execFileSync("python3", [lock, path, process.execPath, "-e", "process.exit(0)"], { stdio: "ignore" });
  } finally {
    first.kill("SIGTERM");
    await firstExit;
    await rm(dir, { recursive: true, force: true });
  }
});

test("Runnerを強制終了しても旧Agentが保持するlockで二重起動しない", async () => {
  const dir = await mkdtemp(join(tmpdir(), "compass-resumption-crash-"));
  const path = join(dir, "worktree.lock");
  const runner = spawn("python3", [lock, path, process.execPath, "-e", "console.log(process.pid); setTimeout(()=>{}, 1500)"], { stdio: ["ignore", "pipe", "pipe"] });
  const exit = new Promise((resolve) => runner.once("exit", (code, signal) => resolve({ code, signal })));
  try {
    await new Promise<void>((resolve) => runner.stdout!.once("data", () => resolve()));
    runner.kill("SIGKILL");
    assert.deepEqual(await exit, { code: null, signal: "SIGKILL" });
    const next = spawn("python3", [lock, path, process.execPath, "-e", "process.exit(0)"], { stdio: "ignore" });
    assert.equal(await new Promise((resolve) => next.once("exit", resolve)), 75);
    // 旧Agentのstdoutが閉じるまで待ち、完了後は新Runnerがlockを取得できる。
    await new Promise<void>((resolve) => runner.stdout!.once("end", () => resolve()));
    execFileSync("python3", [lock, path, process.execPath, "-e", "process.exit(0)"], { stdio: "ignore" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
