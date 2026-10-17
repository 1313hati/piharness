import assert from "node:assert/strict";
import { test } from "node:test";
import { FlailGuard, renderFlailNudge } from "../src/quality/flail.js";

/** Drive the guard the way the extension layer does: start then end. */
function run(guard: FlailGuard, id: string, tool: string, args: unknown, isError = false): void {
  guard.start(id, tool, args);
  guard.end(id, isError);
}

test("flail: three edits to one file without a check is a loop", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 3; i++) run(guard, `e${i}`, "edit", { path: "game.js" });
  const nudge = guard.check();
  assert.ok(nudge);
  assert.equal(nudge.kind, "edits-without-check");
  assert.match(nudge.text, /3 edits to game\.js/);
  assert.match(nudge.text, /one trace harness/i);
});

test("flail: a successful check clears the evidence", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 3; i++) run(guard, `e${i}`, "edit", { path: "game.js" });
  run(guard, "c0", "bash", { command: "npm test" });
  assert.equal(guard.check(), null);
  assert.deepEqual(guard.snapshot().edits, {});
});

test("flail: a failed check does not count as verification", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 3; i++) run(guard, `e${i}`, "edit", { path: "game.js" });
  run(guard, "c0", "bash", { command: "npm test" }, true);
  const nudge = guard.check();
  assert.ok(nudge);
  assert.equal(nudge.kind, "edits-without-check");
});

test("flail: the same command repeated three times is a loop", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 3; i++) run(guard, `b${i}`, "bash", { command: "node _bot.js" });
  const nudge = guard.check();
  assert.ok(nudge);
  assert.equal(nudge.kind, "repeated-call");
});

test("flail: four probes with no check consolidates into one message", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 4; i++) run(guard, `p${i}`, "bash", { command: `node _probe${i}.js` });
  const nudge = guard.check();
  assert.ok(nudge);
  assert.equal(nudge.kind, "probes-without-check");
  assert.match(nudge.text, /one parameterized harness/i);
});

test("flail: silence under the cooldown, and it only fires once per window", () => {
  const guard = new FlailGuard();
  run(guard, "e0", "edit", { path: "a.js" });
  run(guard, "e1", "edit", { path: "a.js" });
  assert.equal(guard.check(), null, "two edits is not yet a loop");
  run(guard, "e2", "edit", { path: "a.js" });
  assert.ok(guard.check());
  assert.equal(guard.check(), null, "no repeat inside the cooldown window");
});

test("flail: reading files is not an edit", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 5; i++) run(guard, `r${i}`, "read", { path: "game.js" });
  assert.equal(guard.check(), null);
});

test("renderFlailNudge keeps the block identifiable", () => {
  const guard = new FlailGuard();
  for (let i = 0; i < 3; i++) run(guard, `e${i}`, "edit", { path: "x.js" });
  const nudge = guard.check();
  assert.ok(nudge);
  const block = renderFlailNudge(nudge);
  assert.match(block, /^### Stuck detection/);
  assert.match(block, /x\.js/);
});

test("mid-turn: the context hook injects the correction before the next provider call", async () => {
  const { createBuiltinExtensions } = await import("../src/extensions/builtin.js");
  const { harnessInlineExtensions } = await import("../src/pi/extensions.js");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const root = mkdtempSync(join(tmpdir(), "harness-flail-wire-"));
  try {
    const built = createBuiltinExtensions({ cwd: root, agentDir: join(root, "agent") });
    const [extension] = harnessInlineExtensions(built.extensions, { cwd: root, agentDir: join(root, "agent") });
    const handlers: Record<string, (event: never) => unknown> = {};
    const fakePi = {
      registerTool: () => {},
      on: (name: string, fn: (event: never) => unknown) => {
        handlers[name] = fn;
      },
    };
    extension!.factory(fakePi as never);
    const start = handlers.tool_execution_start as (e: unknown) => void;
    const end = handlers.tool_execution_end as (e: unknown) => void;
    for (let i = 0; i < 3; i++) {
      start({ toolCallId: `e${i}`, toolName: "edit", args: { path: "game.js" } });
      end({ toolCallId: `e${i}`, toolName: "edit", isError: false });
    }
    const context = handlers.context as (e: { messages: unknown[] }) => { messages: Array<{ role: string; content: string }> } | undefined;
    const result = context({ messages: [{ role: "user", content: "keep going" }] });
    assert.ok(result, "the context hook must return a modified transcript");
    assert.equal(result.messages.length, 2);
    assert.equal(result.messages[1]?.role, "user");
    assert.match(String(result.messages[1]?.content), /Stuck detection/);
    // And it does not stack: a second call inside the cooldown is a no-op.
    assert.equal(context({ messages: result.messages as unknown[] }), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
