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
  /**
   * What the call is about to write, shown while it runs: the diff lines of an
   * edit, or the head of a new file. "Show me the code", not just the path.
   */
  preview?: string[];
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
/** Diff lines shown while an edit/write runs. */
export const PREVIEW_LINES = 6;
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
  if (block.streaming && out.length > 0) {
    // The caret costs a column: reserve it instead of overflowing the terminal
    // (pi-tui throws when any rendered line is wider than the viewport).
    const last = out.length - 1;
    out[last] = truncateToWidth(out[last], Math.max(1, width - 1), "…") + fg(p.accent, "▌");
  }
  return out;
}

function renderThinking(block: ThinkingBlock, width: number, p: Palette): string[] {
  const body = wrap(block.text, Math.max(1, width - 4));
  return body.map((l, i) => dim(fg(p.muted, `${i === 0 ? "· " : "  "}${l}`)));
}

export function renderTool(block: ToolBlock, width: number, p: Palette): string[] {
  const bullet =
    block.status === "running"
      ? fg(p.accentSoft, "◌")
      : block.status === "ok"
        ? fg(p.accentSoft, "✓")
        : fg(p.error, "✗");
  const timing =
    block.ms !== undefined ? dim(fg(p.muted, ` ${(block.ms / 1000).toFixed(1)}s`)) : "";
  const head = `${bullet} ${bold(fg(p.text, block.name))}${
    block.detail ? fg(p.muted, "  ") + fg(p.muted, block.detail) : ""
  }${timing}`;
  const out = [truncateToWidth(head, width, "…")];

  for (const line of (block.preview ?? []).slice(0, PREVIEW_LINES)) {
    const removed = line.startsWith("-");
    const added = line.startsWith("+");
    const colour = removed ? p.error : added ? p.accent : p.muted;
    out.push(`  ${fg(p.accentSoft, "│")} ${fg(colour, dim(truncateToWidth(line, Math.max(1, width - 4), "…")))}`);
  }

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
  // Safety net: a single wide line kills the whole TUI, so nothing leaves this
  // module wider than the viewport, whatever a block or palette does.
  return out.map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line));
}

// ─── chrome ─────────────────────────────────────────────────────────────────

export interface BannerInfo {
  /** Shown next to the harness name; omitted when unknown. */
  version?: string;
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
  const version = info.version ? ` · v${info.version}` : "";
  const row2 = fg(p.muted, truncateToWidth(` local agent harness · ${place}${version}`, width, "…"));
  const row3 = fg(
    p.muted,
    truncateToWidth(" /help commands  ·  /settings preferences  ·  piharness ps  watch from another terminal", width, "…"),
  );
  return [padTo(row1, width, p.bg), padTo(row2, width, p.bg), padTo(row3, width, p.bg)];
}

export interface StatusInfo {
  busy: boolean;
  toolCalls: number;
  tokens: number;
  elapsedMs: number;
  hint: string;
  /** Generation speed, e.g. "12.3 t/s" ("" hides it). */
  rate?: string;
  /** Context usage, e.g. "ctx 8.2k/32k 26%" ("" hides it). */
  context?: string;
  /** GPU load, e.g. "gpu 87% 21.4/24.0G" ("" hides it). */
  gpu?: string;
  /** What the agent is doing now: "generating", "⚙ bash", "thinking". */
  activity?: string;
  /** Tokens streamed this turn (estimate), e.g. "+412 tok". */
  stream?: string;
  /** Time since the last event, e.g. "idle 6s" / "stalled 31s". */
  idle?: string;
  /** Animated busy glyph (◐◓◑◒) so a slow turn still looks alive. */
  spinner?: string;
}

export function renderStatus(info: StatusInfo, width: number, p: Palette): string[] {
  const dot = info.busy ? fg(p.accent, info.spinner ?? "◐") : fg(p.accentSoft, "○");
  const sep = fg(p.muted, "  ·  ");
  const hint = fg(p.muted, info.hint);

  // Segments in priority order, most useful first: generation speed is the
  // meter people actually watch, GPU is the first thing to go when the
  // terminal is narrow. Rate is never dropped — it is the one number this
  // footer exists for.
  // Pinned segments never drop: what it is doing and how fast it is going are
  // the two answers to "is it stuck?". Everything else degrades with width.
  const pinnedSegs = [info.activity, info.rate].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const optional = [info.stream, info.idle, info.context, `tokens ${info.tokens}`, info.gpu].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const base = [`${dot} ${info.busy ? "working" : "ready"}`, `tools ${info.toolCalls}`,
    `${(info.elapsedMs / 1000).toFixed(1)}s`];

  const build = (segments: string[], extra: string[]) =>
    [base[0], base[1], ...pinnedSegs, ...extra, ...segments, base[2]].join(sep);
  // The idle/stall warning is the last thing to go before the pinned pair.
  const warn = info.idle && /^stalled/.test(info.idle) ? info.idle : undefined;
  const rest = optional.filter((s) => s !== warn);
  let shown = [...rest];
  let left = build(shown, warn ? [warn] : []);
  while (visibleWidth(left) + visibleWidth(hint) + 3 > width && shown.length > 0) {
    shown = shown.slice(0, -1);
    left = build(shown, warn ? [warn] : []);
  }
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(hint) - 2);
  return [padTo(`${fg(p.text, left)}${" ".repeat(gap)}${hint}`, width, p.surface)];
}
