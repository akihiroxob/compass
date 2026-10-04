import { appendFileSync } from "node:fs";

/**
 * 実プロセスの停止・回収を確かめるテスト用Agent（fixture）。起動・終了を記録して `SLEEP_AGENT_MS` だけ動く。
 * `SLEEP_AGENT_IGNORE_SIGTERM=1` では SIGTERM を無視する（SIGKILL でしか止まらない Agent）。
 */
const env = process.env;
const log = (event: string, fields: Record<string, unknown> = {}) =>
  appendFileSync(env.SLEEP_AGENT_LOG!, `${JSON.stringify({ event, pid: process.pid, attempt: Number(env.COMPASS_DISPATCH_ATTEMPT), at: Date.now(), ...fields })}\n`);
log("start", { credentialVisible: Object.hasOwn(env, "RUNTIME_TOKEN"), role: env.COMPASS_ROLE });
process.on("SIGTERM", () => {
  if (env.SLEEP_AGENT_IGNORE_SIGTERM === "1") return log("sigterm_ignored");
  log("end", { by: "SIGTERM" });
  process.exit(143);
});
await new Promise((resolve) => setTimeout(resolve, Number(env.SLEEP_AGENT_MS ?? 60_000)));
log("end", { by: "finished" });
