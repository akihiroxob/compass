import assert from "node:assert/strict";
import test from "node:test";
import { runCli } from "../src/runCli.ts";

test("unknown and incomplete commands do not call a Use Case", async () => {
  const unexpected = async (): Promise<never> => { throw new Error("Use Case must not run"); };
  const services = {
    grantProjectRoleUseCase: { execute: unexpected },
    revokeProjectRoleUseCase: { execute: unexpected },
    listProjectGrantsUseCase: { execute: unexpected },
  };
  for (const args of [[], ["grant"], ["revoke"], ["grants"], ["archive", "project"], ["delete", "project"], ["restore", "project"]]) {
    const result = await runCli(args, services);
    assert.equal(result.exitCode, 2);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Usage:/);
    assert.doesNotMatch(result.stderr, /Use Case must not run/);
  }
});

test("grants delegates to the injected Use Case and renders its result", async () => {
  const calls: string[] = [];
  const unexpected = async (): Promise<never> => { throw new Error("Unexpected write"); };
  const services = {
    grantProjectRoleUseCase: { execute: unexpected },
    revokeProjectRoleUseCase: { execute: unexpected },
    listProjectGrantsUseCase: { execute: async (id: string) => { calls.push(id); return []; } },
  };
  const result = await runCli(["grants", "project"], services);
  assert.deepEqual(calls, ["project"]);
  assert.deepEqual(result, { stdout: '{"grants":[]}', stderr: "", exitCode: 0 });
});
