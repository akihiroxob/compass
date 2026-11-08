import assert from "node:assert/strict";
import test from "node:test";
import { workspacePlacement } from "../src/web/features/outcome/outcomeFormPlacement.ts";

test("Outcome編集の戻り先・保存後は、一覧の絞り込み条件(router state)を引き継ぐ", () => {
  const state = { listSearch: "?q=%E5%88%9D%E5%9B%9E&problem=present" };
  const placement = workspacePlacement("w1", "i1", "o1", state);
  assert.equal(placement.state, state);
  assert.equal(placement.back.to, "/workspaces/w1/direction/intents/i1/outcomes/o1");
  assert.equal(placement.savedTo({ id: "o1" } as never), placement.back.to);
  assert.equal(workspacePlacement("w1", "i1", undefined, null).state, null);
});
