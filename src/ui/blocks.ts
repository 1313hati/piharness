/**
 * Transcript model + renderer for the piharness TUI.
 *
 * Deliberately pure: blocks in, lines out, no terminal, no timers. The app
 * shell owns the terminal; this file owns what the user actually reads, and
 * that split is what makes the look testable without a pty.
 */

import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type Palette, bg, bold, dim, fg, padTo } from "./theme.js";

export type ToolStatus = "running" | "ok" | "error";

export interface UserBlock {
  kind: "user";
  text: string;
}

export interface AssistantBlock {
  kind: "assistant";
  text: string;
  streaming: boolean;
}

export interface ThinkingBlock {
  kind: "thinking";
  text: string;
}

export interface ToolBlock {
  kind: "tool";
  name: string;
  /** One-line summary of the call, e.g. the command or the file path. */
  detail: string;
  status: ToolStatus;
  /** First lines of the result; the TUI never dumps a full 200-line log. */
  output: string[];
  /** True when output was cut, so the reader knows nothing is missing silently. */
  truncated: boolean;
  /** Wall-clock duration, when known. */
  ms?: number;
}

export interface NoticeBlock {
  kind: "notice";
  text: string;
  level: "info" | "ok" | "error";
}

export type TranscriptBlock =
  | UserBlock
  | AssistantBlock
  | ThinkingBlock
  | ToolBlock
  | NoticeBlock;

/** How many result lines a tool block shows before collapsing. */
export const TOOL_OUTPUT_LINES = 4;

export function emptyTranscript(): TranscriptBlock[] {
  return [];
}

// ─── small text helpers ─────────────────────────────────────────────────────

function wrap(text: string, width: number): string[] {
  if (width <= 0) return [];
  const out: string[] = [];
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw === "") {
      out.push("");
      continue;
    }
    out.push(...wrapTextWithAnsi(raw, width));
  }
  return out;
}

function firstLine(text: string, width: number): string {
  const one = text.replace(/\s+/g, " ").trim();
  return truncateToWidth(one, width, "…");
}

/**
 * Markdown-ish assistant text: keep the words, drop the syntax noise that a
 * terminal can't render, and keep fenced code visually separate. This is a
 * deliberate subset — a full markdown renderer belongs in a library, and
 * pretending to render tables/bold lists badly looks worse than plain text.
 */
export function renderAssistantText(text: string, width: number, p: Palette): string[] {
  const lines: string[] = [];
  let inFence = false;
  for (const raw of text.replace(/\r\n/g, "\n").split("\n")) {
    if (raw.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      lines.push(...wrap(raw, width).map((l) => dim(fg(p.muted, `  │ ${l}`))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
    if (heading) {
      lines.push(...wrap(heading[2], width).map((l) => bold(fg(p.text, l))));
      continue;
    }
    const bullet = /^\s*[-*]\s+(.*)$/.exec(raw);
    if (bullet) {
      const wrapped = wrap(bullet[1], width - 2);
      wrapped.forEach((l, i) =>
        lines.push(`${i === 0 ? fg(p.accent, "  • ") : "    "}${fg(p.text, l)}`),
      );
      continue;
    }
    lines.push(...wrap(raw, width).map((l) => fg(p.text, l)));
  }
  return lines;
}

// ─── block renderers ────────────────────────────────────────────────────────

export function renderUser(block: UserBlock, width: number, p: Palette): string[] {
  const label = bold(fg(p.accent, "you"));
  const head = ` ▌ ${label}  `;
  const indent = " ".repeat(Math.max(1, visibleWidth(head)));
  const bodyWidth = Math.max(1, width - visibleWidth(head));
  const body = wrap(block.text, bodyWidth);
  if (body.length === 0) return [padTo(head, width, p.surface)];

  const out = [padTo(`${head}${fg(p.text, body[0])}`, width, p.surface)];
  for (const line of body.slice(1)) {
    out.push(padTo(`${indent}${fg(p.text, line)}`, width, p.surface));
  }
  return out;
}

function renderAssistant(block: AssistantBlock, width: number, p: Palette): string[] {
  const body = renderAssistantText(block.text, Math.max(1, width - 2), p);
  if (body.length === 0) return [];
  const glyph = fg(p.accentSoft, "│");
  const out = body.map((line, i) => (i === 0 ? `${glyph} ${line}` : `  ${line}`));
  // Streaming cursor: only the last line, so it reads as an insertion point.
  if (block.streaming && out.length > 0) out[out.length - 1] += fg(p.accent, "▌");
  return out;
}

function renderThinking(block: ThinkingBlock, width: number, p: Palette): string[] {
  const body = wrap(block.text, Math.max(1, width - 4));
  return body.map((l, i) => dim(fg(p.muted, `${i === 0 ? "· " : "  "}${l}`)));
}

export function renderTool(block: ToolBlock, width: number, p: Palette): string[] {
  const bullet =
    block.status === "running"
      ? fg(p.accentSoft, "●")
      : block.status === "ok"
        ? fg(p.accent, "●")
        : fg(p.error, "●");
  const timing =
    block.ms !== undefined ? dim(fg(p.muted, ` ${(block.ms / 1000).toFixed(1)}s`)) : "";
  const head = `${bullet} ${bold(fg(p.text, block.name))}${
    block.detail ? fg(p.muted, "  ") + fg(p.muted, block.detail) : ""
  }${timing}`;
  const out = [truncateToWidth(head, width, "…")];

  const shown = block.output.slice(0, TOOL_OUTPUT_LINES);
  for (const line of shown) {
    for (const wrapped of wrap(line, Math.max(1, width - 4))) {
      out.push(`  ${fg(p.accentSoft, "│")} ${dim(fg(p.muted, wrapped))}`);
    }
  }
  const hidden = block.output.length - shown.length;
  if (hidden > 0) {
    out.push(`  ${fg(p.accentSoft, "│")} ${dim(fg(p.muted, `… ${hidden} more line${hidden === 1 ? "" : "s"}`))}`);
  } else if (block.truncated) {
    out.push(`  ${fg(p.accentSoft, "│")} ${dim(fg(p.muted, "… output truncated"))}`);
  }
  return out;
}

export function renderNotice(block: NoticeBlock, width: number, p: Palette): string[] {
  const color = block.level === "error" ? p.error : block.level === "ok" ? p.accent : p.muted;
  const glyph = block.level === "error" ? "✗" : block.level === "ok" ? "✓" : "·";
  return wrap(block.text, Math.max(1, width - 2)).map((l, i) =>
    i === 0 ? `${fg(color, glyph)} ${fg(color, l)}` : `  ${fg(color, l)}`,
  );
}

export function renderBlock(block: TranscriptBlock, width: number, p: Palette): string[] {
  switch (block.kind) {
    case "user":
      return renderUser(block, width, p);
    case "assistant":
      return renderAssistant(block, width, p);
    case "thinking":
      return renderThinking(block, width, p);
    case "tool":
      return renderTool(block, width, p);
    case "notice":
      return renderNotice(block, width, p);
  }
}

/**
 * Render the whole transcript. Blocks are separated by one blank line, except
 * tool blocks, which read as a list and stay tight.
 */
export function renderTranscript(blocks: TranscriptBlock[], width: number, p: Palette): string[] {
  const out: string[] = [];
  blocks.forEach((block, i) => {
    if (i > 0) {
      const prev = blocks[i - 1];
      if (!(prev.kind === "tool" && block.kind === "tool")) out.push("");
    }
    out.push(...renderBlock(block, width, p));
  });
  return out;
}

// ─── chrome ─────────────────────────────────────────────────────────────────

export interface BannerInfo {
  provider: string;
  model: string;
  cwd: string;
  workspace: string;
}

/**
 * Two-row banner. The wordmark is orange-on-black reversed (a block), which is
 * the strongest accent on screen and sets the palette expectation immediately.
 */
export function renderBanner(info: BannerInfo, width: number, p: Palette): string[] {
  const mark = `${bg(p.accent, fg(p.bg, bold(" PIHARNESS ")))}`;
  const model = fg(p.muted, `${info.provider}/${info.model}`);
  const gap = Math.max(1, width - visibleWidth(mark) - visibleWidth(model) - 2);
  const row1 = `${mark}${" ".repeat(gap)}${model}`;
  const place = truncateToWidth(info.workspace || info.cwd, width, "…");
  const row2 = fg(p.muted, ` local agent harness · ${place}`);
  return [padTo(row1, width, p.bg), padTo(row2, width, p.bg)];
}

export interface StatusInfo {
  busy: boolean;
  toolCalls: number;
  tokens: number;
  elapsedMs: number;
  hint: string;
}

export function renderStatus(info: StatusInfo, width: number, p: Palette): string[] {
  const dot = info.busy ? fg(p.accent, "◐") : fg(p.accentSoft, "○");
  const left = [
    `${dot} ${info.busy ? "working" : "ready"}`,
    `tools ${info.toolCalls}`,
    `tokens ${info.tokens}`,
    `${(info.elapsedMs / 1000).toFixed(1)}s`,
  ].join(fg(p.muted, "  ·  "));
  const hint = fg(p.muted, info.hint);
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(hint) - 2);
  return [padTo(`${fg(p.text, left)}${" ".repeat(gap)}${hint}`, width, p.surface)];
}
