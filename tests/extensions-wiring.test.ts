import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { harnessInlineExtensions } from "../src/pi/extensions.js";

/**
 * The gates are only real if pi actually calls them. These tests drive the
 * extension factory with a stub `pi` and replay the event shapes, so a renamed
 * event or a changed field fails here instead of silently doing nothing in the
 * TUI — which is exactly how "the harness ignores me" happens.
 */

type Handler = (event: any) => any;

function boot(cwd: string) {
  const handlers = new Map<string, Handler>();
  const tools: any[] = [];
  const pi = {
    registerTool: (tool: any) => tools.push(tool),
    on: (name: string, fn: Handler) => handlers.set(name, fn),
  };
  const ext = harnessInlineExtensions(
    [{ name: "test", description: "t", tools: [], context: () => "### extra context" }],
    { cwd, agentDir: cwd },
  )[0];
  assert.ok(ext, "the extension must exist when harness extensions are supplied");
  ext.factory(pi as any);
  return { handlers, tools };
}

function tmp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "piharness-wire-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("a turn that edits code and verifies nothing gets one continue, not a loop", () => {
  const dir = tmp({ "a.ts": "export const a = 1;\n" });
  const { handlers } = boot(dir);
  handlers.get("before_agent_start")!({ systemPrompt: "You are a coding agent operating inside pi, with tools.", prompt: "fix a.ts" });

  handlers.get("tool_execution_start")!({ toolCallId: "1", toolName: "write", args: { path: "a.ts", content: "x" } });
  handlers.get("tool_execution_end")!({ toolCallId: "1", toolName: "write", isError: false });

  const settle = handlers.get("agent_before_settle")!;
  const first = settle({ outcome: "completed", entries: [], continue: false, context: {}, messages: [] });
  assert.equal(first?.continue, true, "the turn must not be allowed to end unverified");
  assert.equal(first?.entries?.[0]?.type, "custom_message");
  assert.match(first.entries[0].content, /a\.ts/);
  assert.match(first.entries[0].content, /unverified, not finished/);

  const second = settle({ outcome: "completed", entries: [], continue: false, context: {}, messages: [] });
  assert.equal(second, undefined, "second settle must not nag again");

  const aborted = settle({ outcome: "aborted", entries: [], continue: false, context: {}, messages: [] });
  assert.equal(aborted, undefined, "an interrupted turn is not a finished one");
});

test("the same turn is fine when it runs the project check", () => {
  const dir = tmp({ "a.ts": "x\n", "package.json": JSON.stringify({ scripts: { test: "tsx --test" } }) });
  const { handlers } = boot(dir);
  handlers.get("before_agent_start")!({ systemPrompt: "operating inside pi, with tools", prompt: "go" });

  handlers.get("tool_execution_start")!({ toolCallId: "1", toolName: "edit", args: { path: "a.ts", edits: [] } });
  handlers.get("tool_execution_end")!({ toolCallId: "1", toolName: "edit", isError: false });
  handlers.get("tool_execution_start")!({ toolCallId: "2", toolName: "bash", args: { command: "npm test" } });
  handlers.get("tool_execution_end")!({ toolCallId: "2", toolName: "bash", isError: false });

  assert.equal(handlers.get("agent_before_settle")!({ outcome: "completed" }), undefined);
});

test("edit is blocked until the file has been read, and prose edits are unaffected", () => {
  const dir = tmp({ "a.ts": "export const a = 1;\n" });
  const { handlers } = boot(dir);
  const call = handlers.get("tool_call")!;

  const blocked = call({ toolName: "edit", input: { path: "a.ts", edits: [{ oldText: "1", newText: "2" }] } });
  assert.equal(blocked?.block, true);
  assert.match(blocked.reason, /read a\.ts before editing/);

  handlers.get("tool_execution_start")!({ toolCallId: "9", toolName: "read", args: { path: "a.ts" } });
  handlers.get("tool_execution_end")!({ toolCallId: "9", toolName: "read", isError: false });
  assert.equal(call({ toolName: "edit", input: { path: "a.ts", edits: [] } }), undefined);

  assert.equal(call({ toolName: "bash", input: { command: "ls" } }), undefined, "only edit is guarded");
});

test("the first turn carries the machine facts and the rules, not just tools", () => {
  const dir = tmp({ "package.json": JSON.stringify({ scripts: { test: "tsx --test" } }) });
  const { handlers } = boot(dir);
  const res = handlers.get("before_agent_start")!({ systemPrompt: "You are a coding agent operating inside pi, with tools.", prompt: "hi" });
  assert.match(res.systemPrompt, /operating inside piharness/);
  assert.match(res.systemPrompt, /## This machine \(probed, not assumed\)/);
  assert.match(res.systemPrompt, /project checks .*npm test/);
  assert.match(res.systemPrompt, /### extra context/);
});
