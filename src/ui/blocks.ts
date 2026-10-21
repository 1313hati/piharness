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

/**
 * One already-wrapped reasoning line. Reasoning is emitted as immutable lines
 * rather than one growing block: a block that keeps getting taller has to be
 * redrawn above the cursor, which is what made the transcript look like it had
 * a separate reasoning pane and forced scrolling. Appended lines never change
 * once printed — the same shape Hermes uses.
 */
export interface ThinkingLineBlock {
  kind: "thinkingLine";
  text: string;
}

/** The `⋯ reasoning` label above a run of thinking lines. */
export interface ThinkingHeadBlock {
  kind: "thinkingHead";
  suppressed?: boolean;
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
  | ThinkingLineBlock
  | ThinkingHeadBlock
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

/**
 * Split streamed prose into printable lines without waiting for a newline.
 * Returns the lines that are complete at this width plus the tail to keep
 * buffering. A reasoning model streams one long paragraph, so breaking on
 * width (at a space when possible) is what makes the thought appear live.
 */
export function breakLines(text: string, width: number): { lines: string[]; rest: string } {
  const lines: string[] = [];
  let buf = text;
  let nl = buf.indexOf("\n");
  while (nl !== -1) {
    if (buf.slice(0, nl).trim()) lines.push(buf.slice(0, nl));
    buf = buf.slice(nl + 1);
    nl = buf.indexOf("\n");
  }
  while (buf.length > width) {
    const space = buf.lastIndexOf(" ", width);
    const at = space > width * 0.5 ? space : width;
    if (buf.slice(0, at).trim()) lines.push(buf.slice(0, at));
    buf = buf.slice(at).replace(/^ +/, "");
  }
  return { lines, rest: buf };
}

export function wrap(text: string, width: number): string[] {
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

/**
 * Append-order owner for the transcript.
 *
 * The rule that matters: a text segment begins where nothing else was appended
 * since the previous one. Keeping a single growing assistant block for a whole
 * turn anchored every later sentence — including the final answer — above the
 * tool calls that had already scrolled past, which is what made a linear
 * session read as scrambled. Reasoning is sealed by whatever comes next, so a
 * thought is never printed after the answer it produced.
 */
export class TranscriptBuilder {
  readonly blocks: TranscriptBlock[] = [];
  /** Open assistant segment; null once any other block is appended. */
  private assistant: AssistantBlock | null = null;
  /** Reasoning that has not become a printed line yet. */
  private thinkingBuf = "";
  private thinkingOpen = false;
  /** Width of the last reasoning delta; wrapping can never be redone later. */
  private width = 100;

  /** Start a turn: segment state only — history stays. */
  beginTurn(): void {
    this.assistant = null;
    this.thinkingBuf = "";
    this.thinkingOpen = false;
  }

  /** Reasoning delta: printed as immutable lines, in transcript order. */
  thinking(delta: string, width: number): void {
    this.width = Math.max(20, width);
    if (!this.thinkingOpen) {
      this.thinkingOpen = true;
      this.blocks.push({ kind: "thinkingHead" });
    }
    this.sealAssistant();
    this.thinkingBuf += delta;
    this.flushThinking(false);
  }

  /** Print every complete reasoning line; `all` also prints the tail. */
  flushThinking(all: boolean): void {
    const { lines, rest } = breakLines(this.thinkingBuf, this.width);
    for (const line of lines) this.blocks.push({ kind: "thinkingLine", text: line });
    this.thinkingBuf = rest;
    if (all && rest.trim()) {
      for (const line of wrap(rest, this.width)) this.blocks.push({ kind: "thinkingLine", text: line });
      this.thinkingBuf = "";
    }
  }

  /** Prose delta. Resumes a segment only if nothing was appended since. */
  text(delta: string): void {
    if (!this.assistant) {
      this.flushThinking(true);
      this.thinkingOpen = false;
      this.assistant = { kind: "assistant", text: "", streaming: true };
      this.blocks.push(this.assistant);
    }
    this.assistant.text += delta;
  }

  /** A tool, notice or user block: closes the open segment, then lands. */
  append(block: TranscriptBlock): void {
    this.flushThinking(true);
    this.thinkingOpen = false;
    this.sealAssistant();
    this.blocks.push(block);
  }

  /** Turn over: nothing is still streaming, no reasoning is left unprinted. */
  end(): void {
    this.sealThinking();
    this.sealAssistant();
  }

  /** Keep the history but drop any half-open segment (used by /clear). */
  reset(): void {
    this.beginTurn();
    this.blocks.length = 0;
  }

  private sealThinking(): void {
    this.flushThinking(true);
    this.thinkingOpen = false;
  }

  private sealAssistant(): void {
    if (!this.assistant) return;
    this.assistant.streaming = false;
    this.assistant = null;
  }
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

/**
 * Reasoning is shown, not summarised: the whole point of streaming it is that
 * a long turn is visibly *working* rather than silently stuck. It stays
 * visually subordinate (muted, no bullet chrome) but readable — plain `muted`
 * instead of `dim(muted)`, which on a near-black background was invisible.
 */
function renderThinking(block: ThinkingBlock, width: number, p: Palette): string[] {
  const body = wrap(block.text.trimEnd(), Math.max(1, width - 4));
  if (body.length === 0) return [];
  const head = fg(p.accentSoft, "⋯ ") + fg(p.muted, "reasoning");
  const out = [truncateToWidth(head, width, "…")];
  for (const line of body) out.push(fg(p.muted, `  ${line}`));
  return out;
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
    case "thinkingHead":
      return [truncateToWidth(fg(p.accentSoft, "⋯ ") + fg(p.muted, "reasoning"), width, "…")];
    case "thinkingLine": {
      const line = fg(p.muted, `  ${block.text}`);
      return [visibleWidth(line) > width ? truncateToWidth(line, width, "…") : line];
    }
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
      // Reasoning reads as one continuous, tight paragraph: no blank lines
      // between its header and its lines, or between consecutive lines.
      const tight =
        (prev.kind === "tool" && block.kind === "tool") ||
        (prev.kind === "thinkingLine" && block.kind === "thinkingLine") ||
        (prev.kind === "thinkingHead" && block.kind === "thinkingLine") ||
        (prev.kind === "thinkingHead" && block.kind === "thinkingHead");
      if (!tight) out.push("");
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
  /** Server-side progress, e.g. "prefill 2k/3k" or "412 tok". */
  server?: string;
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
  const optional = [info.server, info.stream, info.idle, info.context, `tokens ${info.tokens}`, info.gpu].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  // The idle/stall warning is the last thing to go before the pinned pair.
  const warn = info.idle && /^stalled/.test(info.idle) ? info.idle : undefined;

  let shown = optional.filter((s) => s !== warn);
  // `tools 0` is the least informative number on the footer and dropping it is
  // cheaper than dropping the key hint, so it goes before the hint does.
  let withTools = true;
  let showHint = true;

  const build = () =>
    [
      `${dot} ${info.busy ? "working" : "ready"}`,
      ...(withTools ? [`tools ${info.toolCalls}`] : []),
      ...pinnedSegs,
      ...(warn ? [warn] : []),
      ...shown,
      `${(info.elapsedMs / 1000).toFixed(1)}s`,
    ].join(sep);
  const needed = (line: string) =>
    visibleWidth(line) + (showHint ? visibleWidth(hint) + 3 : 0);

  let left = build();
  // Every droppable thing goes before the line is allowed to overflow: a
  // single column too many makes pi-tui throw and takes the session with it.
  while (needed(left) > width && (shown.length > 0 || withTools || showHint)) {
    if (shown.length > 0) shown = shown.slice(0, -1);
    else if (withTools) withTools = false;
    else showHint = false;
    left = build();
  }

  if (!showHint) {
    return [padTo(truncateToWidth(fg(p.text, left), width, "…"), width, p.surface)];
  }
  const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(hint) - 2);
  const line = `${fg(p.text, left)}${" ".repeat(gap)}${hint}`;
  // Last-resort guard for absurdly narrow terminals and over-long tool names.
  return [padTo(truncateToWidth(line, width, "…"), width, p.surface)];
}
