import assert from "node:assert/strict";
import { test } from "node:test";
import { mergeContextUsage } from "../src/pi/session.js";

test("context usage: live numbers win, cached estimate fills the gap", () => {
  const live = { tokens: 8200, contextWindow: 66_000, percent: 12.4 };
  assert.deepEqual(mergeContextUsage(live, 23_000), live);

  // Right after a compaction: no fresh tokens, so show the estimate.
  const afterCompact = mergeContextUsage({ tokens: null, contextWindow: 66_000, percent: null }, 23_000);
  assert.equal(afterCompact?.tokens, 23_000);
  assert.equal(Math.round(afterCompact!.percent!), 35);

  // No estimate either: pass Pi's answer through rather than inventing one.
  assert.deepEqual(mergeContextUsage({ tokens: null, contextWindow: 66_000, percent: null }, undefined), {
    tokens: null,
    contextWindow: 66_000,
    percent: null,
  });

  assert.equal(mergeContextUsage(undefined, 1000), undefined);

  // A zero window must not produce NaN%.
  assert.equal(mergeContextUsage({ tokens: null, contextWindow: 0, percent: null }, 10)?.percent, null);
});
