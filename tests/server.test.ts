import assert from "node:assert/strict";
import test from "node:test";
import { formatProgress, parseSlots, serverUrl } from "../src/ui/server.js";

test("parseSlots: picks the busy slot and reads its counters", () => {
  const p = parseSlots([
    { id: 0, is_processing: false },
    { id: 1, is_processing: true, n_prompt_tokens: 3300, n_prompt_tokens_processed: 1200, n_decoded: 0 },
  ]);
  assert.deepEqual(p, { prefill: 1200, prefillTotal: 3300, decoded: 0, running: true });
});

test("parseSlots: null when the server is idle, and on junk", () => {
  assert.equal(parseSlots([{ is_processing: false }]), null);
  assert.equal(parseSlots(null), null);
  assert.equal(parseSlots({}), null);
});

test("parseSlots: accepts a single slot object, not just the array", () => {
  const p = parseSlots({ is_processing: true, n_prompt_tokens: 100, n_prompt_tokens_processed: 100, n_decoded: 42 });
  assert.equal(p?.decoded, 42);
});

test("formatProgress: prefill count, then decode count, empty when nothing yet", () => {
  assert.equal(formatProgress({ prefill: 1200, prefillTotal: 3300, decoded: 0, running: true }), "prefill 1k");
  assert.equal(formatProgress({ prefill: 0, prefillTotal: 45000, decoded: 0, running: true }), "", "stale totals are not shown");
  assert.equal(formatProgress({ prefill: 200, prefillTotal: 3300, decoded: 0, running: true }), "", "never 'prefill 0k'");
  assert.equal(formatProgress({ prefill: 3300, prefillTotal: 3300, decoded: 412, running: true }), "412 tok");
});

test("serverUrl: env override, localhost default", () => {
  const saved = process.env.PIHARNESS_SERVER_URL;
  try {
    delete process.env.PIHARNESS_SERVER_URL;
    assert.equal(serverUrl(), "http://127.0.0.1:8080");
    process.env.PIHARNESS_SERVER_URL = "http://localhost:9090";
    assert.equal(serverUrl(), "http://localhost:9090");
  } finally {
    if (saved === undefined) delete process.env.PIHARNESS_SERVER_URL;
    else process.env.PIHARNESS_SERVER_URL = saved;
  }
});
