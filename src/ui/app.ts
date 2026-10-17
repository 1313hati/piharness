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

import { appendFileSync, readFileSync } from "node:fs";
import {
  Editor,
  type EditorTheme,
  ProcessTerminal,
  type TuiInputListenerResult,
  TuiMainScreen,
  type Component,
  VStack,
} from "@earendil-works/pi-tui";
import type { HarnessSession, NormalizedEvent, ThinkingLevel } from "../pi/session.js";
import {
  PREVIEW_LINES,
  type TranscriptBlock,
  type ToolBlock,
  renderBanner,
  renderStatus,
  renderTranscript,
} from "./blocks.js";
import { BLACK_ORANGE, type Palette, bold, fg, maybeDisableForPipe, setColorEnabled } from "./theme.js";
import {
  type ContextInfo,
  type GpuInfo,
  StreamMeter,
  formatContext,
  formatDuration,
  formatGpu,
  formatIdle,
  formatRate,
  formatStreamTokens,
  formatTokens,
} from "./stats.js";
import { startGpuSampler } from "./gpu.js";
import { formatProgress, sampleServer, type ServerProgress } from "./server.js";
import { clearLiveState, writeLiveState } from "./live.js";
import { defaultAgentDir } from "../pi/agent-dir.js";
import { addTodo, completeTodo, loadTodos, removeTodo, renderTodos } from "../extensions/todo.js";
import { deriveEvidence } from "../learn/evidence.js";
import { DEFAULT_MIN_EVIDENCE, learnFromSession } from "../learn/mine.js";
import { loadSettings, renderSettings, settingsPath } from "../config/settings.js";
import { addFact, globalMemoryPath, loadMemoryFile, memoryPath, renderFacts } from "../context/memory.js";

export interface TuiOptions {
  session: HarnessSession;
  provider: string;
  model: string;
  cwd: string;
  workspace: string;
  /** Harness agent dir (global memory lives here). */
  agentDir?: string;
  /** Tool names exposed to the model, for /extensions. */
  toolNames?: string[];
  /** Loaded extension modules/dirs, for /extensions. */
  extensionInfo?: () => { paths: string[]; diagnostics: string[] };
  palette?: Palette;
  /** How much the model may reason before acting (shown in /think, /stats). */
  thinkingLevel?: ThinkingLevel;
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
    private info: {
      busy: boolean;
      toolCalls: number;
      tokens: number;
      elapsedMs: number;
      hint: string;
      rate?: string;
      context?: string;
      gpu?: string;
      server?: string;
      activity?: string;
      stream?: string;
      idle?: string;
      spinner?: string;
    },
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
/** Single source for the banner and --version. */
const VERSION = (() => {
  try {
    return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version?: string }).version;
  } catch {
    return undefined;
  }
})();

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

export async function runTui(options: TuiOptions): Promise<TranscriptBlock[]> {
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
    rate: "",
    context: "",
    gpu: "",
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
  /** Start time per tool call, for the duration shown when it finishes. */
  let toolStarted = new Map<string, number>();
  let lastCtrlC = 0;
  let closed = false;
  const meter = new StreamMeter();
  let gpuInfo: GpuInfo | null = null;
  let serverInfo: ServerProgress | null = null;
  // The server meter exists to cover the silent prefill. Once tokens are
  // actually on screen it is noise, and its counters can be stale.
  let turnSawOutput = false;
  let lastTurnOutputTokens: number | null = null;
  let stopGpu: () => void = () => {};
  /** Duration of the last finished turn, so the footer doesn't snap back to 0.0s. */
  let currentThinking: ThinkingLevel = options.thinkingLevel ?? "medium";
  let lastTurnMs = 0;
  /** Turn start, kept after the turn so /stats can report time to first token. */
  let lastTurnStart = Date.now();
  /** Last time anything happened: a stream delta or a tool event. */
  let lastEventAt = Date.now();
  /** Tool currently executing, if any. */
  let currentTool: string | null = null;
  const startedAt = new Date().toISOString();

  const contextInfo = (): ContextInfo | null => {
    try {
      return options.session.getContextUsage() ?? null;
    } catch {
      return null;
    }
  };

  const refreshStatus = () => {
    const stats = options.session.getSessionStats();
    const elapsedMs = turn ? Date.now() - turn.startedAt : lastTurnMs;
    status.set({
      busy: Boolean(turn) && !turn?.finalised,
      toolCalls: stats.toolCalls,
      tokens: stats.tokens.total,
      elapsedMs,
      hint: turn ? "ctrl+c cancels" : HINT,
      rate: formatRate(meter.rate()),
      context: formatContext(contextInfo()),
      gpu: formatGpu(gpuInfo),
      server: serverInfo ? formatProgress(serverInfo) : "",
      activity: turn && !turn.finalised
        ? currentTool
          ? `⚙ ${currentTool}`
          : meter.tokens() > 0
            ? "generating"
            : "waiting for first token"
        : "",
      stream: turn && !turn.finalised ? formatStreamTokens(meter.tokens()) : "",
      idle: turn && !turn.finalised ? formatIdle(Date.now() - lastEventAt) : "",
      spinner: "◐◓◑◒"[Math.floor(Date.now() / 250) % 4],
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
    lastTurnStart = turn.startedAt;
    toolBlocks = new Map();
    toolStarted = new Map();
    meter.reset();
    const stats = options.session.getSessionStats();
    lastTurnOutputTokens = stats.tokens.output;
    refreshStatus();
  };

  const endTurn = (aborted: boolean) => {
    if (!turn) return;
    lastTurnMs = Date.now() - turn.startedAt;
    try {
      const stats = options.session.getSessionStats();
      const before = lastTurnOutputTokens ?? 0;
      meter.finish(Math.max(0, stats.tokens.output - before), lastTurnMs);
    } catch {
      // keep the streaming estimate
    }
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

  // PIHARNESS_TRACE_EVENTS=<file> records what Pi actually emitted, with
  // timestamps. It is the difference between "the harness is not rendering"
  // and "the model never sent it" when a turn looks silent.
  const tracePath = process.env.PIHARNESS_TRACE_EVENTS;
  const trace = (event: NormalizedEvent) => {
    if (!tracePath) return;
    try {
      appendFileSync(
        tracePath,
        `${JSON.stringify({
          t: Date.now(),
          type: event.type,
          chars: "text" in event ? event.text.length : undefined,
          tool: "toolName" in event ? event.toolName : undefined,
        })}\n`,
      );
    } catch {
      // tracing must never break a session
    }
  };

  const onEvent = (event: NormalizedEvent) => {
    lastEventAt = Date.now();
    trace(event);
    switch (event.type) {
      case "agent_start":
        turnSawOutput = false;
        serverInfo = null;
        beginTurn();
        break;
      case "thinking_delta": {
        turnSawOutput = true;
        // Thinking tokens count towards t/s: with a reasoning model most of
        // the generation happens here, and ignoring it made the meter idle.
        meter.delta(event.text);
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
        turnSawOutput = true;
        if (!turn) break;
        meter.delta(event.text);
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
          preview: previewFromArgs(event.toolName, event.args),
        };
        toolBlocks.set(event.toolCallId, block);
        toolStarted.set(event.toolCallId, Date.now());
        currentTool = event.toolName;
        push(block);
        refreshStatus();
        break;
      }
      // Partial tool output (bash streaming): the block fills in while it runs,
      // so a long build looks alive instead of silent.
      case "tool_update": {
        const block = toolBlocks.get(event.toolCallId);
        if (!block) break;
        const { lines, truncated } = summarizeResult(event.partial);
        if (lines.length > 0) {
          block.output = lines;
          block.truncated = truncated;
          refreshStatus();
        }
        break;
      }
      case "tool_end": {
        const block = toolBlocks.get(event.toolCallId);
        if (!block) break;
        const { lines, truncated } = summarizeResult(event.result);
        block.status = event.isError ? "error" : "ok";
        block.output = lines;
        block.truncated = truncated;
        const started = toolStarted.get(event.toolCallId);
        block.ms = typeof event.durationMs === "number" ? event.durationMs : started ? Date.now() - started : undefined;
        currentTool = null;
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
    stopGpu();
    clearLiveState(options.agentDir ?? defaultAgentDir(), process.pid);
    setTitle("piharness");
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
          "/help  /status  /stats  /compact [notes]  /todos  /memory  /learn  /settings  /extensions  /clear  /model  /quit\n" +
            "Enter sends · Ctrl+C cancels a running task · /todos add <text> · /memory add <fact>",
        );
        return;
      case "/status": {
        const stats = options.session.getSessionStats();
        notice(
          `${options.provider}/${options.model} · tools ${stats.toolCalls} · tokens ${stats.tokens.total} · cwd ${options.cwd}`,
        );
        return;
      }
      case "/stats": {
        const stats = options.session.getSessionStats();
        const ctx = contextInfo();
        const lines = [
          `model      ${options.provider}/${options.model}`,
          `session    ${options.session.sessionId}`,
          `speed      ${formatRate(meter.rate()) || "—"}`,
          `context    ${formatContext(ctx) || "unknown"}`,
          `tokens     ${stats.tokens.total} total (${stats.tokens.input} in / ${stats.tokens.output} out)`,
          `tools      ${stats.toolCalls} calls${options.toolNames?.length ? ` · ${options.toolNames.join(", ")}` : ""}`,
          `turn       ${formatDuration(lastTurnMs)} last`,
          `ttft       ${formatDuration(meter.ttftMs(lastTurnStart) ?? 0)} (time to first token)`,
          `thinking   ${currentThinking} (change with /think)`,
          gpuInfo
            ? `gpu        ${formatGpu(gpuInfo)}${gpuInfo.tempC ? ` · ${gpuInfo.tempC}°C` : ""} (${gpuInfo.gpus} device${gpuInfo.gpus === 1 ? "" : "s"})`
            : "gpu        unavailable",
          `session    ${options.session.sessionFile ?? "(not persisted yet)"}`,
        ];
        for (const line of lines) notice(line);
        return;
      }
      case "/compact": {
        if (turn) {
          notice("cancel the running turn before compacting (Ctrl+C)", "error");
          return;
        }
        const instructions = input.slice("/compact".length).trim();
        notice("compacting conversation…");
        try {
          const res = await options.session.compact(instructions || undefined);
          notice(
            `compacted: ${formatTokens(res.tokensBefore)} → ${formatTokens(res.estimatedTokensAfter ?? 0)} tokens` +
              ` · summary ${res.summary.length} chars`,
            "ok",
          );
        } catch (err) {
          notice(`compaction failed: ${err instanceof Error ? err.message : String(err)}`, "error");
        }
        refreshStatus();
        return;
      }
      case "/todos":
        return handleTodos(input.slice("/todos".length).trim());
      case "/memory":
        return handleMemory(input.slice("/memory".length).trim());
      case "/think": {
        const level = input.slice("/think".length).trim() as ThinkingLevel;
        if (!level) {
          notice(`thinking: ${currentThinking} (usage: /think off|low|medium|high)`);
          break;
        }
        if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) {
          notice(`unknown level "${level}" — use off|low|medium|high`);
          break;
        }
        options.session.setThinkingLevel(level);
        currentThinking = level;
        notice(`thinking: ${level}${level === "off" ? " (fastest, weakest on multi-file edits)" : ""}`);
        break;
      }
      case "/learn": {
        const evidence = deriveEvidence(transcript.blocks, { cwd: options.cwd });
        if (!evidence) {
          notice("nothing to learn yet: this session has not called a tool");
          break;
        }
        const result = learnFromSession(options.cwd, evidence, {
          autoPromote: process.env.PIHARNESS_AUTO_PROMOTE !== undefined
            ? process.env.PIHARNESS_AUTO_PROMOTE !== "0"
            : settings.learn.autoPromote,
          minEvidence: Number(process.env.PIHARNESS_MIN_EVIDENCE ?? settings.learn.minEvidence ?? DEFAULT_MIN_EVIDENCE),
        });
        notice(
          result.action === "none"
            ? `not learned: ${result.reason}`
            : `${result.action}: ${result.name} — ${result.reason}`,
          result.action === "promoted" ? "ok" : "info",
        );
        break;
      }
      case "/settings": {
        const file = settingsPath(options.agentDir ?? defaultAgentDir());
        notice(renderSettings(loadSettings(options.agentDir ?? defaultAgentDir()), file).join("\n"));
        break;
      }
      case "/extensions": {
        const info = options.extensionInfo?.();
        notice(`tools: ${options.toolNames?.join(", ") ?? "none"}`);
        if (info) {
          notice(`loaded: ${info.paths.length > 0 ? info.paths.join(", ") : "built-ins only"}`);
          for (const d of info.diagnostics) notice(`extension problem: ${d}`, "error");
        }
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

  const handleTodos = (arg: string): void => {
    const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
    const text = rest.join(" ").trim();
    try {
      if (!verb) {
        const body = renderTodos(loadTodos(options.cwd), { includeDone: false });
        notice(body || "todo list is empty — /todos add <text>");
        return;
      }
      if (verb === "add") {
        if (!text) return notice("usage: /todos add <text>", "error");
        const item = addTodo(options.cwd, text);
        notice(`added ${item.id}: ${item.text}`, "ok");
      } else if (verb === "done") {
        const item = completeTodo(options.cwd, text);
        notice(item ? `done ${item.id}: ${item.text}` : `no todo matches ${JSON.stringify(text)}`, item ? "ok" : "error");
      } else if (verb === "rm" || verb === "remove") {
        const item = removeTodo(options.cwd, text);
        notice(item ? `removed ${item.id}` : `no todo matches ${JSON.stringify(text)}`, item ? "ok" : "error");
      } else {
        notice("usage: /todos [add|done|rm] <text>", "error");
      }
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const handleMemory = (arg: string): void => {
    const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
    const text = rest.join(" ").trim();
    const agentDir = options.agentDir;
    try {
      if (verb === "add" || verb === "remember") {
        if (!text) return notice("usage: /memory add <fact>", "error");
        const fact = addFact(options.cwd, text);
        notice(`remembered ${fact.id}: ${fact.fact}`, "ok");
        return;
      }
      const project = renderFacts(loadMemoryFile(memoryPath(options.cwd)).facts, 50, 4_000);
      notice(`project memory:\n${project || "(empty)"}`);
      if (agentDir) {
        const global = renderFacts(loadMemoryFile(globalMemoryPath(agentDir)).facts, 50, 4_000);
        notice(`global memory:\n${global || "(empty)"}`);
      }
    } catch (err) {
      notice(err instanceof Error ? err.message : String(err), "error");
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

  const settings = loadSettings(options.agentDir ?? defaultAgentDir());

  // Keep the elapsed clock and the GPU meter moving.
  // Sample the model server while a turn is live: this is the only signal that
  // moves during prefill, before Pi has a single token to render.
  const serverTimer = setInterval(() => {
    if (!turn || !status || turnSawOutput) {
      serverInfo = null;
      return;
    }
    void sampleServer().then((p) => {
      if (p) serverInfo = p;
      else if (serverInfo) serverInfo = null;
    });
  }, 700);
  serverTimer.unref?.();

  if (settings.ui.gpu) stopGpu = startGpuSampler({
    onSample: (gpu) => {
      gpuInfo = gpu;
      // Only redraw for telemetry while idle; during a turn the stream already
      // triggers renders, and a GPU frame every 2.5s would just add noise.
      if (!turn) refreshStatus();
    },
  });

  // Heartbeat: refresh the footer while working (so a slow model never looks
  // frozen) and publish the live state file for `piharness ps`.
  const setTitle = (text: string) => {
    if (!process.stdout.isTTY) return;
    try {
      process.stdout.write(`\x1b]0;${text}\x07`);
    } catch {
      // a title is a nicety, never a failure
    }
  };

  const ticker = setInterval(() => {
    if (turn && !turn.finalised) refreshStatus();
    setTitle(
      turn && !turn.finalised
        ? `piharness · ${meter.tokens() > 0 ? "generating" : "waiting"} · ${formatRate(meter.rate()) || "…"}`
        : `piharness · ready`,
    );
    const stats = options.session.getSessionStats();
    const busy = Boolean(turn) && !turn?.finalised;
    writeLiveState(options.agentDir ?? defaultAgentDir(), {
      version: 1,
      pid: process.pid,
      sessionId: options.session.sessionId,
      cwd: options.cwd,
      model: `${options.provider}/${options.model}`,
      startedAt,
      updatedAt: new Date().toISOString(),
      phase: busy ? (currentTool ? "tool" : "generating") : "idle",
      tool: currentTool ?? undefined,
      turnStartedAt: turn ? new Date(turn.startedAt).toISOString() : undefined,
      idleMs: busy ? Date.now() - lastEventAt : 0,
      rate: meter.rate() ?? undefined,
      streamedTokens: meter.tokens(),
      toolCalls: stats.toolCalls,
      tokens: stats.tokens.total,
    });
  }, 500);

  // ─── go ───────────────────────────────────────────────────────────────────

  const banner = renderBanner(
    { provider: options.provider, model: options.model, cwd: options.cwd, workspace: options.workspace, version: VERSION },
    Math.max(20, terminal.columns),
    palette,
  );
  terminal.write(banner.join("\n") + "\n\n");

  tui.setFocus(editor);
  tui.start();
  tui.requestRender();

  await closedPromise;
  // The caller may want the transcript for the learning loop.
  return transcript.blocks;
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
/**
 * The diff (or file head) a write-ish tool is about to apply. Rendered while
 * the call runs, which is what makes "it is coding" observable rather than a
 * spinner that says "edit".
 */
export function previewFromArgs(toolName: string, args: unknown): string[] {
  const a = (args ?? {}) as Record<string, unknown>;
  const lines: string[] = [];
  const pushBlock = (text: unknown, sign: "-" | "+") => {
    if (typeof text !== "string" || !text.trim()) return;
    for (const line of text.replace(/\r\n/g, "\n").split("\n").slice(0, PREVIEW_LINES)) {
      lines.push(`${sign} ${line}`);
    }
  };
  const name = toolName.toLowerCase();
  if (Array.isArray(a.edits)) {
    for (const edit of a.edits.slice(0, 2) as Array<Record<string, unknown>>) {
      pushBlock(edit.oldText, "-");
      pushBlock(edit.newText, "+");
    }
  } else if (typeof a.content === "string" && ["write", "create", "write_file", "edit_file"].includes(name)) {
    pushBlock(a.content, "+");
  } else if (typeof a.patch === "string") {
    for (const line of a.patch.split("\n").slice(0, PREVIEW_LINES)) lines.push(line);
  }
  return lines.slice(0, PREVIEW_LINES + 2);
}

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
