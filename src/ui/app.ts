/**
 * The piharness TUI shell.
 *
 * Layout is a single column in the terminal's main screen:
 *
 *   █ PIHARNESS █                               local/qwen38
 *    local agent harness · /home/hati/code/piharness
 *
 *   ▌ you
 *   ▌ fix the failing test
 *   ● edit  src/sum.ts
 *     │ ok
 *   │ Here is the fix ...
 *
 *   ○ ready  ·  tools 4  ·  tokens 1832  ·  7.2s        /help  /quit
 *   ┌──────────────────────────────────────────────┐
 *   │ ❯ type a task…                               │
 *   └──────────────────────────────────────────────┘
 *
 * Everything visual lives in ./blocks.ts and ./theme.ts; this file owns the
 * terminal, the session wiring, and the key bindings.
 */

import {
  Editor,
  type EditorTheme,
  ProcessTerminal,
  type TuiInputListenerResult,
  TuiMainScreen,
  type Component,
  VStack,
} from "@earendil-works/pi-tui";
import type { HarnessSession, NormalizedEvent } from "../pi/session.js";
import {
  type TranscriptBlock,
  type ToolBlock,
  renderBanner,
  renderStatus,
  renderTranscript,
} from "./blocks.js";
import { BLACK_ORANGE, type Palette, bold, fg, maybeDisableForPipe, setColorEnabled } from "./theme.js";

export interface TuiOptions {
  session: HarnessSession;
  provider: string;
  model: string;
  cwd: string;
  workspace: string;
  palette?: Palette;
  /** Test seam: skip the real terminal. */
  terminal?: ProcessTerminal;
}

interface TurnState {
  startedAt: number;
  assistantIndex: number | null;
  thinkingIndex: number | null;
  finalised: boolean;
}

/** A component that renders the transcript; the TUI diffs its output. */
class TranscriptView implements Component {
  blocks: TranscriptBlock[] = [];
  constructor(private readonly palette: Palette) {}
  render(width: number): string[] {
    return renderTranscript(this.blocks, width, this.palette);
  }
  invalidate(): void {}
}

class StatusLine implements Component {
  constructor(
    private readonly palette: Palette,
    private info: { busy: boolean; toolCalls: number; tokens: number; elapsedMs: number; hint: string },
  ) {}
  set(info: Partial<typeof this.info>): void {
    this.info = { ...this.info, ...info };
  }
  render(width: number): string[] {
    return renderStatus(this.info, width, this.palette);
  }
  invalidate(): void {}
}

const HINT = "/help  /quit";

/**
 * The TUI hands Ctrl+C to the focused component, not to input listeners, so
 * the editor has to be the thing that decides what an interrupt means.
 */
class HarnessEditor extends Editor {
  onInterrupt?: () => void;
  override handleInput(data: string): void {
    if (data === "\x03") {
      this.onInterrupt?.();
      return;
    }
    super.handleInput(data);
  }
}

export async function runTui(options: TuiOptions): Promise<void> {
  const palette = options.palette ?? BLACK_ORANGE;
  maybeDisableForPipe(Boolean(process.stdout.isTTY));
  setColorEnabled(!process.env.NO_COLOR && process.stdout.isTTY !== false);

  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TuiMainScreen(terminal);
  const transcript = new TranscriptView(palette);
  const status = new StatusLine(palette, {
    busy: false,
    toolCalls: 0,
    tokens: 0,
    elapsedMs: 0,
    hint: HINT,
  });

  const editor = new HarnessEditor(
    tui,
    {
      borderColor: (s: string) => fg(palette.accentSoft, s),
      selectList: {
        selectedPrefix: (s) => fg(palette.accent, s),
        selectedText: (s) => bold(fg(palette.text, s)),
        description: (s) => fg(palette.muted, s),
        scrollInfo: (s) => fg(palette.muted, s),
        noMatch: (s) => fg(palette.muted, s),
      },
    } as EditorTheme,
    { paddingX: 1 },
  );

  tui.addChild(new VStack([transcript, status, editor]));

  // ─── turn bookkeeping ─────────────────────────────────────────────────────

  let turn: TurnState | null = null;
  let toolBlocks = new Map<string, ToolBlock>();
  let lastCtrlC = 0;
  let closed = false;
  /** Duration of the last finished turn, so the footer doesn't snap back to 0.0s. */
  let lastTurnMs = 0;

  const refreshStatus = () => {
    const stats = options.session.getSessionStats();
    status.set({
      busy: Boolean(turn) && !turn?.finalised,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens.total,
      elapsedMs: turn ? Date.now() - turn.startedAt : lastTurnMs,
      hint: turn ? "ctrl+c cancels" : HINT,
    });
    transcript.invalidate();
    tui.requestRender();
  };

  const push = (block: TranscriptBlock): number => {
    transcript.blocks.push(block);
    return transcript.blocks.length - 1;
  };

  const beginTurn = () => {
    turn = { startedAt: Date.now(), assistantIndex: null, thinkingIndex: null, finalised: false };
    toolBlocks = new Map();
    refreshStatus();
  };

  const endTurn = (aborted: boolean) => {
    if (!turn) return;
    lastTurnMs = Date.now() - turn.startedAt;
    if (turn.assistantIndex !== null) {
      const block = transcript.blocks[turn.assistantIndex];
      if (block?.kind === "assistant") block.streaming = false;
    }
    if (turn.thinkingIndex !== null) {
      const block = transcript.blocks[turn.thinkingIndex];
      if (block?.kind === "thinking") {
        const chars = block.text.trim().length;
        if (chars > 0) {
          transcript.blocks[turn.thinkingIndex] = {
            kind: "notice",
            level: "info",
            text: `thought ${chars} chars`,
          };
        } else {
          transcript.blocks.splice(turn.thinkingIndex, 1);
        }
      }
    }
    turn.finalised = true;
    if (aborted) push({ kind: "notice", level: "info", text: "cancelled" });
    turn = null;
    refreshStatus();
  };

  const onEvent = (event: NormalizedEvent) => {
    switch (event.type) {
      case "agent_start":
        beginTurn();
        break;
      case "thinking_delta": {
        if (!turn) break;
        if (turn.thinkingIndex === null) {
          turn.thinkingIndex = push({ kind: "thinking", text: event.text });
        } else {
          const block = transcript.blocks[turn.thinkingIndex];
          if (block.kind === "thinking") block.text += event.text;
        }
        refreshStatus();
        break;
      }
      case "text_delta": {
        if (!turn) break;
        if (turn.assistantIndex === null) {
          turn.assistantIndex = push({ kind: "assistant", text: event.text, streaming: true });
        } else {
          const block = transcript.blocks[turn.assistantIndex];
          if (block.kind === "assistant") block.text += event.text;
        }
        refreshStatus();
        break;
      }
      case "tool_start": {
        const block: ToolBlock = {
          kind: "tool",
          name: event.toolName,
          detail: summarizeArgs(event.args),
          status: "running",
          output: [],
          truncated: false,
        };
        toolBlocks.set(event.toolCallId, block);
        push(block);
        refreshStatus();
        break;
      }
      case "tool_end": {
        const block = toolBlocks.get(event.toolCallId);
        if (!block) break;
        const { lines, truncated } = summarizeResult(event.result);
        block.status = event.isError ? "error" : "ok";
        block.output = lines;
        block.truncated = truncated;
        refreshStatus();
        break;
      }
      case "agent_end":
        endTurn(event.aborted);
        break;
      case "error":
        push({ kind: "notice", level: "error", text: event.message });
        refreshStatus();
        break;
      default:
        break;
    }
  };

  const unsub = options.session.subscribe(onEvent);

  // ─── commands ─────────────────────────────────────────────────────────────

  const notice = (text: string, level: "info" | "ok" | "error" = "info") => {
    push({ kind: "notice", level, text });
    transcript.invalidate();
    tui.requestRender();
  };

  const close = () => {
    if (closed) return;
    closed = true;
    clearInterval(ticker);
    unsub();
    tui.stop();
    resolveClosed();
  };

  let resolveClosed: () => void = () => {};
  const closedPromise = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });

  const handleCommand = async (input: string): Promise<void> => {
    const [cmd] = input.split(/\s+/);
    switch (cmd) {
      case "/quit":
      case "/exit":
        close();
        return;
      case "/help":
        notice(
          "/help  /status  /clear  /model  /quit — Enter sends, Ctrl+C cancels a running task",
        );
        return;
      case "/status": {
        const stats = options.session.getSessionStats();
        notice(
          `${options.provider}/${options.model} · tools ${stats.toolCalls} · tokens ${stats.tokens.total} · cwd ${options.cwd}`,
        );
        return;
      }
      case "/clear":
        transcript.blocks.length = 0;
        transcript.invalidate();
        tui.requestRender();
        return;
      case "/model":
        notice(`${options.provider}/${options.model}  (set with --provider/--model or .harness/config.json)`);
        return;
      default:
        notice(`unknown command: ${cmd} — try /help`, "error");
    }
  };

  const submit = async (raw: string): Promise<void> => {
    const text = raw.trim();
    if (!text) return;
    editor.setText("");
    if (text.startsWith("/")) {
      await handleCommand(text);
      return;
    }
    if (turn) {
      notice("still working — Ctrl+C to cancel", "info");
      return;
    }
    push({ kind: "user", text });
    beginTurn();
    try {
      await options.session.prompt(text);
      await options.session.waitForIdle();
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), "error");
    } finally {
      if (turn) endTurn(false);
      else refreshStatus();
    }
  };

  editor.onSubmit = (text: string) => {
    void submit(text);
  };

  // Ctrl+C: cancel while busy; otherwise a second press within 1.5s quits.
  editor.onInterrupt = () => {
    if (turn) {
      // End the turn in the UI immediately: pi's abort() cancels the HTTP
      // request, but llama.cpp keeps decoding for a while and the agent_end
      // event may never arrive. A stuck "working" footer is worse than a
      // slightly early "cancelled".
      endTurn(true);
      void options.session.abort().catch(() => {});
      return;
    }
    const now = Date.now();
    if (now - lastCtrlC < 1500) {
      close();
      return;
    }
    lastCtrlC = now;
    notice("press Ctrl+C again to quit, or type /quit");
  };

  // Keep the elapsed clock moving while a turn is in flight.
  const ticker = setInterval(() => {
    if (turn && !turn.finalised) refreshStatus();
  }, 500);

  // ─── go ───────────────────────────────────────────────────────────────────

  const banner = renderBanner(
    { provider: options.provider, model: options.model, cwd: options.cwd, workspace: options.workspace },
    Math.max(20, terminal.columns),
    palette,
  );
  terminal.write(banner.join("\n") + "\n\n");

  tui.setFocus(editor);
  tui.start();
  tui.requestRender();

  await closedPromise;
}

// ─── event payload summarising ──────────────────────────────────────────────

/** Pick the argument that tells the reader *what* the call touched. */
export function summarizeArgs(args: unknown): string {
  if (!args || typeof args !== "object") return String(args ?? "");
  const a = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "filePath", "pattern", "url", "query"]) {
    const value = a[key];
    if (typeof value === "string" && value.trim()) return oneLine(value, 90);
  }
  const json = JSON.stringify(a);
  return json === "{}" ? "" : oneLine(json, 90);
}

/** Flatten a tool result to display lines, capping the volume. */
export function summarizeResult(result: unknown, maxLines = 60): { lines: string[]; truncated: boolean } {
  const text = extractText(result);
  if (!text) return { lines: [], truncated: false };
  const all = text.replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
  const lines = all.slice(0, maxLines);
  return { lines, truncated: all.length > maxLines };
}

function extractText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result === "object") {
    const r = result as Record<string, unknown>;
    if (Array.isArray(r.content)) {
      return r.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
            return (part as { text: string }).text;
          }
          return "";
        })
        .filter(Boolean)
        .join("\n");
    }
    for (const key of ["output", "stdout", "text", "message", "error"]) {
      if (typeof r[key] === "string") return r[key] as string;
    }
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }
  return String(result);
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
