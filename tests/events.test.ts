import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeEvent, type NormalizedEvent } from "../src/pi/session.ts";

// normalizeEvent takes the upstream AgentSessionEvent union. In unit tests we
// pass the minimal shape per event type; unknown fields are irrelevant.
function ev(partial: Record<string, unknown>): never {
  return partial as never;
}

test("agent_start passes through", () => {
  const out = normalizeEvent(ev({ type: "agent_start" }));
  assert.deepEqual(out, { type: "agent_start" });
});

test("agent_end (per model turn) is dropped, not surfaced", () => {
  const out = normalizeEvent(ev({ type: "agent_end", messages: [], willRetry: false }));
  assert.equal(out, null);
});

test("agent_settled is surfaced as agent_end with aborted=false", () => {
  const out = normalizeEvent(ev({ type: "agent_settled", aborted: false }));
  assert.deepEqual(out, { type: "agent_end", aborted: false });
});

test("agent_settled with aborted=true is surfaced as agent_end aborted", () => {
  const out = normalizeEvent(ev({ type: "agent_settled", aborted: true }));
  assert.deepEqual(out, { type: "agent_end", aborted: true });
});

test("message_update with text_delta extracts delta from assistantMessageEvent", () => {
  const out = normalizeEvent(
    ev({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_delta", delta: "hello" },
    }),
  );
  assert.deepEqual(out, { type: "text_delta", text: "hello" });
});

test("message_update with thinking_delta extracts delta", () => {
  const out = normalizeEvent(
    ev({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
    }),
  );
  assert.deepEqual(out, { type: "thinking_delta", text: "hmm" });
});

test("message_update with top-level delta (wrong shape) is dropped", () => {
  const out = normalizeEvent(
    ev({
      type: "message_update",
      message: { role: "assistant" },
      delta: "not the right place",
    }),
  );
  assert.equal(out, null);
});

test("message_update with non-delta assistantMessageEvent type is dropped", () => {
  const out = normalizeEvent(
    ev({
      type: "message_update",
      message: { role: "assistant" },
      assistantMessageEvent: { type: "text_start" },
    }),
  );
  assert.equal(out, null);
});

test("tool_execution_start is normalized to tool_start", () => {
  const out = normalizeEvent(
    ev({
      type: "tool_execution_start",
      toolCallId: "tc1",
      toolName: "bash",
      args: { command: "ls" },
    }),
  );
  assert.deepEqual(out, {
    type: "tool_start",
    toolName: "bash",
    toolCallId: "tc1",
    args: { command: "ls" },
  });
});

test("tool_execution_update is normalized to tool_update", () => {
  const out = normalizeEvent(
    ev({
      type: "tool_execution_update",
      toolCallId: "tc9",
      toolName: "bash",
      partialResult: "building…\n",
    }),
  );
  assert.deepEqual(out, { type: "tool_update", toolName: "bash", toolCallId: "tc9", partial: "building…\n" });
});

test("tool_execution_end carries durationMs when measured", () => {
  const out = normalizeEvent(
    ev({ type: "tool_execution_end", toolCallId: "tc1", toolName: "bash", result: "ok", durationMs: 1234 }),
  );
  assert.equal((out as { durationMs?: number }).durationMs, 1234);
});

test("tool_execution_end is normalized to tool_end with isError default false", () => {
  const out = normalizeEvent(
    ev({
      type: "tool_execution_end",
      toolCallId: "tc1",
      toolName: "bash",
      result: "ok",
    }),
  );
  assert.deepEqual(out, {
    type: "tool_end",
    toolName: "bash",
    toolCallId: "tc1",
    result: "ok",
    isError: false,
  });
});

test("tool_execution_end with isError=true is preserved", () => {
  const out = normalizeEvent(
    ev({
      type: "tool_execution_end",
      toolCallId: "tc2",
      toolName: "read",
      result: { error: "ENOENT" },
      isError: true,
    }),
  );
  assert.equal(out?.type, "tool_end");
  if (out?.type === "tool_end") {
    assert.equal(out.isError, true);
  }
});

test("auto_retry_start is normalized to error with attempt info", () => {
  const out = normalizeEvent(
    ev({
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 500,
      errorMessage: "boom",
    }),
  );
  assert.deepEqual(out, { type: "error", message: "Retry 1/3: boom" });
});

test("compaction events pass through", () => {
  assert.deepEqual(normalizeEvent(ev({ type: "compaction_start" })), { type: "compaction_start" });
  assert.deepEqual(normalizeEvent(ev({ type: "compaction_end" })), { type: "compaction_end" });
});

test("unknown event types are dropped", () => {
  assert.equal(normalizeEvent(ev({ type: "something_new" })), null);
});
