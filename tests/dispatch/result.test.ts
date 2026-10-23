import assert from "node:assert/strict";
import { test } from "node:test";
import { describe, result } from "../../src/dispatch/result.ts";

for (const [lease, wording] of [["preserved", "Its lease is retained."], ["none", "Its lease was returned."]] as const) {
  test(`finished summaries report lease ${lease} in text and JSON`, () => {
    const value = result({ ok: true, reason: "finished", stage: "finish", lease, observed: {}, nextAction: "none" });
    const json = JSON.parse(JSON.stringify(value));
    assert.equal(json.summary, `The attempt was finished under the context's finalisation policy: its task is recorded as done. ${wording}`);
    assert.equal(describe(value).split("\n")[0], `OK: finished at finish – ${json.summary}`);
  });
}
