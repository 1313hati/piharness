import assert from "node:assert/strict";
import { test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { previewFromArgs, summarizeArgs, summarizeResult } from "../src/ui/app.js";
import {
  renderAssistantText,
  renderBanner,
  renderStatus,
  renderTool,
  renderTranscript,
  renderUser,
} from "../src/ui/blocks.js";
import { BLACK_ORANGE, bg, fg, padTo, setColorEnabled } from "../src/ui/theme.js";

const P = BLACK_ORANGE;

/** WCAG relative luminance, for the "is this actually readable" checks. */
function luminance(hex: string): number {
  const h = hex.replace("#", "");
  const channels = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16) / 255);
  const [r, g, b] = channels.map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

test("palette: orange accent and text are readable on the black background", () => {
  assert.ok(contrast(P.text, P.bg) >= 7, `text contrast ${contrast(P.text, P.bg).toFixed(1)}`);
  assert.ok(contrast(P.accent, P.bg) >= 7, `accent contrast ${contrast(P.accent, P.bg).toFixed(1)}`);
  assert.ok(contrast(P.muted, P.bg) >= 4.5, `muted contrast ${contrast(P.muted, P.bg).toFixed(1)}`);
  // The background really is near-black, not a dark grey theme.
  assert.ok(luminance(P.bg) < 0.02);
  // The accent is orange: red channel dominant, green present, blue low.
  const accent = P.accent.replace("#", "");
  const r = Number.parseInt(accent.slice(0, 2), 16);
  const g = Number.parseInt(accent.slice(2, 4), 16);
  const b = Number.parseInt(accent.slice(4, 6), 16);
  assert.ok(r > 200 && g > 100 && g < 180 && b < 80, `${r},${g},${b}`);
});

test("color helpers: emit truecolor SGR and degrade to plain text", () => {
  setColorEnabled(true);
  assert.equal(fg("#FF8A1F", "x"), "\x1b[38;2;255;138;31mx\x1b[39m");
  assert.equal(bg("#0B0B0D", "x"), "\x1b[48;2;11;11;13mx\x1b[49m");
  setColorEnabled(false);
  assert.equal(fg("#FF8A1F", "x"), "x");
  assert.equal(bg("#0B0B0D", "x"), "x");
  setColorEnabled(true);
});

test("padTo: fills the row while ignoring ANSI width", () => {
  const line = padTo(fg(P.accent, "hi"), 10, P.bg);
  assert.equal(visibleWidth(line), 10);
  assert.ok(line.includes("\x1b[48;2;11;11;13m"));
});

test("user block: orange rail, black surface card, wrapped to width", () => {
  const lines = renderUser({ kind: "user", text: "fix the failing test please" }, 30, P);
  assert.ok(lines.length >= 1);
  for (const line of lines) assert.equal(visibleWidth(line), 30);
  assert.ok(lines[0].includes("you"));
  assert.ok(lines.join(" ").includes("fix the failing"));
  // Wraps onto continuation rows indented under the label, never above it.
  const narrow = renderUser({ kind: "user", text: "fix the failing test please" }, 18, P);
  assert.ok(narrow.length > 1);
  assert.ok(narrow[0].includes("you"));
});

test("tool block: status colors differ and long output collapses", () => {
  const base = { kind: "tool" as const, name: "bash", detail: "npm test", output: ["a", "b", "c", "d", "e", "f"] };
  const running = renderTool({ ...base, status: "running", truncated: false }, 60, P).join("\n");
  const ok = renderTool({ ...base, status: "ok", truncated: false }, 60, P).join("\n");
  const failed = renderTool({ ...base, status: "error", truncated: false }, 60, P).join("\n");
  assert.notEqual(running, ok);
  assert.notEqual(ok, failed);
  assert.ok(ok.includes("npm test"));
  assert.ok(ok.includes("2 more lines"));
  assert.ok(!ok.includes("│ e"));
});

test("tool result summariser: content parts, strings, and truncation", () => {
  assert.deepEqual(summarizeResult({ content: [{ text: "hello\nworld" }] }).lines, ["hello", "world"]);
  assert.deepEqual(summarizeResult("one\ntwo\n").lines, ["one", "two"]);
  const many = summarizeResult(Array.from({ length: 70 }, (_, i) => `l${i}`).join("\n"));
  assert.equal(many.lines.length, 60);
  assert.equal(many.truncated, true);
  assert.equal(summarizeResult(undefined).lines.length, 0);
});

test("tool args: command first, then path, else compact JSON", () => {
  assert.equal(summarizeArgs({ command: "npm test", path: "x" }), "npm test");
  assert.equal(summarizeArgs({ path: "src/sum.ts" }), "src/sum.ts");
  assert.equal(summarizeArgs({ other: 1 }), '{"other":1}');
  assert.equal(summarizeArgs({}), "");
  assert.equal(summarizeArgs(null), "");
});

test("transcript: blank line between blocks, but consecutive tool calls stay tight", () => {
  const blocks = [
    { kind: "user" as const, text: "hi" },
    { kind: "assistant" as const, text: "hello", streaming: false },
    { kind: "tool" as const, name: "read", detail: "a.ts", status: "ok" as const, output: [], truncated: false },
    { kind: "tool" as const, name: "read", detail: "b.ts", status: "ok" as const, output: [], truncated: false },
  ];
  setColorEnabled(false);
  const lines = renderTranscript(blocks, 40, P);
  setColorEnabled(true);
  const blankIndexes = lines.map((l, i) => (l === "" ? i : -1)).filter((i) => i >= 0);
  // user|assistant boundary and assistant|tool boundary, nothing between the two tools
  assert.equal(blankIndexes.length, 2);
  const toolLine = lines.findIndex((l) => l.includes("read"));
  assert.ok(lines.slice(toolLine + 1).filter((l) => l.includes("read")).length >= 1);
});

test("banner: orange wordmark, model on the right, full width", () => {
  const lines = renderBanner(
    { provider: "local", model: "qwen38", cwd: "/work", workspace: "/work" },
    80,
    P,
  );
  assert.equal(lines.length, 3); // wordmark, path, hint row
  for (const line of lines) assert.equal(visibleWidth(line), 80);
  assert.ok(lines[0].includes("PIHARNESS"));
  assert.ok(lines[0].includes("\x1b[48;2;255;138;31m"), "wordmark is an orange block");
  assert.ok(lines[0].includes("local/qwen38"));
  assert.ok(lines[1].includes("/work"));
});

test("streaming caret never pushes a line past the terminal width", () => {
  const width = 60;
  const long = "x".repeat(width + 20);
  const lines = renderAssistantText("word ".repeat(40) + "▌", width, BLACK_ORANGE, true);
  for (const line of lines) assert.ok(visibleWidth(line) <= width, `line too wide: ${visibleWidth(line)}`);
  const exact = renderAssistantText("y".repeat(width), width, BLACK_ORANGE, true);
  for (const line of exact) assert.ok(visibleWidth(line) <= width);
});

test("preview shows the diff a tool is about to apply", () => {
  const edit = previewFromArgs("edit", { path: "src/sum.ts", edits: [{ oldText: "a - b", newText: "a + b" }] });
  assert.deepEqual(edit, ["- a - b", "+ a + b"]);
  const write = previewFromArgs("write", { path: "x.ts", content: "line one\nline two" });
  assert.deepEqual(write, ["+ line one", "+ line two"]);
  assert.deepEqual(previewFromArgs("bash", { command: "npm test" }), []);
});

test("status: left state, right hint, exact width", () => {
  const line = renderStatus(
    { busy: true, toolCalls: 3, tokens: 1200, elapsedMs: 4200, hint: "/help  /quit" },
    70,
    P,
  )[0];
  assert.equal(visibleWidth(line), 70);
  assert.ok(line.includes("working"));
  assert.ok(line.includes("tools 3"));
  assert.ok(line.includes("4.2s"));
  assert.ok(line.includes("/help  /quit"));
});
