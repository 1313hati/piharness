/**
 * Flail detection.
 *
 * The expensive failure mode observed in real sessions is not a wrong answer —
 * it is a loop: the same file edited four times, the same probe rewritten five
 * times, no check ever run, and the turn ending with the problem still open.
 * The model cannot see that pattern from inside a single step, so the harness
 * watches the tool stream and says it plainly before the next turn.
 *
 * Deliberately deterministic: no model call, no judgement about content. It
 * counts edits, repeats and checks, and only speaks when the counts are bad.
 */

export type FlailKind = "edits-without-check" | "repeated-call" | "probes-without-check";

export interface FlailNudge {
  kind: FlailKind;
  /** What the counts actually are, so the message is not a generic scolding. */
  detail: string;
  text: string;
}

const EDIT_TOOLS = new Set(["write", "edit", "patch", "apply_patch", "multiedit"]);
/** Read-only tools: doing the same read twice is not a loop worth interrupting. */
const READ_TOOLS = new Set(["read", "ls", "list", "grep", "search", "outline", "repo_map", "todo", "todos", "memory", "web_search", "web_fetch", "code_find"]);
const VERIFY_RE =
  /\b(npm (?:run )?test|npm run (?:typecheck|build|check|lint)|npx (?:vitest|tsc|jest)|node --test|tsc\b|pytest|cargo (?:test|build|check)|go test|make (?:test|check)|gpustat)\b/;
/** Cooldown: never nag more often than this many tool calls. */
const NUDGE_COOLDOWN = 5;
/** Same (tool, args) this many times is a loop, not a retry. */
const REPEAT_LIMIT = 3;
/** Edits to one file without a check in between. */
const EDIT_LIMIT = 3;
/** Trace/probe style shell calls without a check. */
const PROBE_LIMIT = 4;

function editPath(args: unknown): string | null {
  if (!args || typeof args !== "object") return null;
  const record = args as Record<string, unknown>;
  const path = record.path ?? record.file_path ?? record.filePath ?? record.file;
  return typeof path === "string" && path.trim() ? path : null;
}

function commandOf(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const record = args as Record<string, unknown>;
  const command = record.command ?? record.cmd;
  return typeof command === "string" ? command : "";
}

function signature(tool: string, args: unknown): string {
  let raw = "";
  try {
    raw = JSON.stringify(args ?? {});
  } catch {
    raw = String(args);
  }
  return `${tool}::${raw.slice(0, 400)}`;
}

export class FlailGuard {
  private readonly edits = new Map<string, number>();
  private readonly repeats = new Map<string, number>();
  private probes = 0;
  private callsSinceCheck = 0;
  private callsSinceNudge = NUDGE_COOLDOWN;
  private lastCheck: string | null = null;
  private pending = new Map<string, { tool: string; args: unknown }>();

  /** Observe a tool call starting (only args are available here). */
  start(toolCallId: string, tool: string, args: unknown): void {
    this.pending.set(toolCallId, { tool, args });
  }

  /** Observe the outcome; a successful check clears the loop evidence. */
  end(toolCallId: string, isError: boolean): void {
    const call = this.pending.get(toolCallId);
    if (!call) return;
    this.pending.delete(toolCallId);
    this.callsSinceCheck++;
    this.callsSinceNudge++;

    const command = commandOf(call.args);
    const isCheck = !isError && VERIFY_RE.test(command);
    if (isCheck) {
      this.lastCheck = command.trim().split("\n")[0]?.slice(0, 80) ?? "check";
      this.edits.clear();
      this.repeats.clear();
      this.probes = 0;
      this.callsSinceCheck = 0;
      return;
    }

    if (EDIT_TOOLS.has(call.tool)) {
      const path = editPath(call.args);
      if (path) this.edits.set(path, (this.edits.get(path) ?? 0) + 1);
      this.probes = 0;
      return;
    }

    if (call.tool === "bash") {
      const sig = signature(call.tool, call.args);
      this.repeats.set(sig, (this.repeats.get(sig) ?? 0) + 1);
      // A shell call that runs code to look at state is a probe; one that edits
      // the repo (sed -i, tee, > file) counts like an edit and resets the count.
      if (/\bsed -i\b|\btee\b|>\s*[^\s|]+\s*$/.test(command)) {
        this.probes = 0;
      } else {
        this.probes++;
      }
      return;
    }

    if (READ_TOOLS.has(call.tool)) return;
    const sig = signature(call.tool, call.args);
    this.repeats.set(sig, (this.repeats.get(sig) ?? 0) + 1);
  }

  /** True when the current state is worth interrupting the model about. */
  check(): FlailNudge | null {
    if (this.callsSinceNudge < NUDGE_COOLDOWN) return null;

    const worstEdit = [...this.edits.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worstEdit && worstEdit[1] >= EDIT_LIMIT) {
      const [path, count] = worstEdit;
      this.callsSinceNudge = 0;
      return {
        kind: "edits-without-check",
        detail: `${count} edits to ${path} since the last check`,
        text: [
          `LOOP: ${count} edits to ${path} and no check has run since. Stop editing it.`,
          `Write one trace harness that prints the state at the failure, run it once, name the cause in one sentence, then change one line and run the check.`,
          `If you cannot name the cause, say what you would need to measure and measure that instead.`,
        ].join("\n"),
      };
    }

    const worstRepeat = [...this.repeats.entries()].sort((a, b) => b[1] - a[1])[0];
    if (worstRepeat && worstRepeat[1] >= REPEAT_LIMIT) {
      this.callsSinceNudge = 0;
      return {
        kind: "repeated-call",
        detail: `the same call ran ${worstRepeat[1]} times`,
        text: [
          `LOOP: you have run the same command ${worstRepeat[1]} times with the same arguments.`,
          `Change the input, not the command: print the state that decides the outcome, or read the code that computes it.`,
        ].join("\n"),
      };
    }

    if (this.probes >= PROBE_LIMIT) {
      const detail = `${this.probes} probe calls since ${this.lastCheck ? `the last check (${this.lastCheck})` : "the session started"}`;
      this.callsSinceNudge = 0;
      return {
        kind: "probes-without-check",
        detail,
        text: [
          `LOOP: ${this.probes} separate probes and no check has run since.`,
          `Consolidate: one parameterized harness, one run, the numbers you actually need. Then make one change and run the project check.`,
        ].join("\n"),
      };
    }

    return null;
  }

  /** Counters for `piharness ps`-style inspection and tests. */
  snapshot(): { edits: Record<string, number>; repeats: number; probes: number; callsSinceCheck: number } {
    return {
      edits: Object.fromEntries(this.edits),
      repeats: [...this.repeats.values()].reduce((a, b) => a + b, 0),
      probes: this.probes,
      callsSinceCheck: this.callsSinceCheck,
    };
  }
}

/** Render a nudge as the system-prompt block the model actually sees. */
export function renderFlailNudge(nudge: FlailNudge): string {
  return `### Stuck detection\n${nudge.text}`;
}
