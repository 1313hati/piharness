/**
 * Coding quality, enforced instead of requested.
 *
 * The observed failure is always the same shape: the model edits files, writes
 * a confident summary, and stops — no test, no build, no run. Nothing in the
 * loop asks for evidence, so "done" means "I typed something". A prompt rule
 * does not fix that (the rule is already there and was ignored); a settle-time
 * gate does, because the turn is not allowed to end without an answer.
 *
 * Two guards live here:
 *   TurnGuard      — counts edits vs. checks in a turn; decides the nudge.
 *   ReadBeforeEdit — blocks `edit` on a file this session never read.
 */

/** Files whose change can break behaviour, as opposed to prose. */
const CODE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|hpp|java|kt|rb|php|sh|bash|sql|css|html|svelte|vue|astro|lua|zig|swift|cs|ex|exs|clj|scala|dart)$/i;

/**
 * Commands that prove something, plus commands that at least execute the thing
 * that was written (`python3 view.py`, `./build/run`). Installing is excluded:
 * `npm install` proves nothing about the change.
 */
const VERIFY_PATTERNS: RegExp[] = [
  /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|typecheck|type-check|build|lint|check|coverage)\b/,
  /\b(?:npx|pnpx|bunx)\s+(?:tsc|vitest|jest|eslint|biome|prettier\s+--check|playwright)\b/,
  /\btsc\b(?:\s|$)/,
  /\b(?:cargo|go)\s+(?:check|test|build|vet|clippy)\b/,
  /\b(?:pytest|py\.test)\b|\bpython3?\s+-m\s+(?:pytest|unittest)\b/,
  /\bnode\s+--test\b/,
  /\b(?:ruff|mypy|eslint|shellcheck|golangci-lint)\b/,
  /\bmake\s+(?:test|check|build|lint)\b/,
  /(?:^|[;&|]\s*)\.\/\S+/,
  /\bpython3?\s+[^\s-]\S*\.py\b/,
  /\bnode\s+[^\s-]\S*\.(?:js|mjs|cjs|ts)\b/,
];

export function isVerificationCommand(command: string): boolean {
  const cmd = command.trim();
  if (!cmd) return false;
  return VERIFY_PATTERNS.some((re) => re.test(cmd));
}

export function isCodeFile(path: string): boolean {
  return CODE_FILE.test(path);
}

const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit", "apply_patch"]);

export interface ToolNote {
  name: string;
  input: unknown;
  /** Only successful calls should be counted as edits. */
  failed?: boolean;
}

function pathOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  for (const key of ["path", "file_path", "filePath"]) {
    const v = obj[key];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

function commandOf(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const obj = input as Record<string, unknown>;
  const v = obj.command ?? obj.cmd;
  return typeof v === "string" ? v : null;
}

/** Per-turn accounting: what changed, and did anything prove it still works. */
export class TurnGuard {
  private edited = new Map<string, number>();
  private checks: string[] = [];
  private nudged = false;

  reset(): void {
    this.edited.clear();
    this.checks = [];
    this.nudged = false;
  }

  /** Call on a successful tool result. */
  note(note: ToolNote): void {
    if (note.failed) return;
    if (EDIT_TOOLS.has(note.name)) {
      const path = pathOf(note.input);
      if (path) this.edited.set(path, (this.edited.get(path) ?? 0) + 1);
      return;
    }
    if (note.name === "bash") {
      const command = commandOf(note.input);
      if (command && isVerificationCommand(command)) this.checks.push(command.trim());
    }
  }

  get editedFiles(): string[] {
    return [...this.edited.keys()];
  }

  get checkCommands(): string[] {
    return [...this.checks];
  }

  /** Code was changed and nothing was ever run against it. */
  get unverified(): boolean {
    return this.editedFiles.some(isCodeFile) && this.checks.length === 0;
  }

  get alreadyNudged(): boolean {
    return this.nudged;
  }

  /** True at most once per turn: a gate that repeats becomes noise. */
  shouldNudge(): boolean {
    return !this.nudged && this.unverified;
  }

  markNudged(): void {
    this.nudged = true;
  }
}

/** Short enough to read, specific enough to act on. */
export function renderVerifyNudge(edited: string[], checks: string[], suggested: string[] = []): string {
  const files = edited.slice(0, 4).join(", ") + (edited.length > 4 ? `, +${edited.length - 4} more` : "");
  const how = suggested.length > 0 ? suggested.join(" / ") : "the project's test or build command";
  const tried = checks.length > 0 ? ` (you ran ${checks[0]}, which did not cover it)` : "";
  return [
    "### Not done yet — nothing has checked this change",
    `You edited ${files} and ran no test, build, or run of it${tried}.`,
    `A turn that changed code and verified nothing is unverified, not finished.`,
    `Run ${how}, read the output, fix what it reports. Then say what the output showed.`,
    `If it genuinely cannot be checked here, say that in one sentence instead.`,
  ].join("\n");
}

/**
 * Reading is how the edit tool learns the file; editing from memory is how it
 * corrupts one. The guard is deliberately lenient about *how* the file was
 * seen (read tool, or a cat/head/sed in bash) and strict only about seeing it
 * at all.
 */
export class ReadBeforeEdit {
  private seen = new Set<string>();

  constructor(private readonly cwd: string) {}

  private normalize(path: string): string {
    if (path.startsWith("/")) return path;
    return `${this.cwd.replace(/\/$/, "")}/${path.replace(/^\.\//, "")}`;
  }

  noteRead(path: string): void {
    this.seen.add(this.normalize(path));
  }

  /** A file this session wrote is known as well: the model chose its content. */
  noteWrite(path: string): void {
    this.seen.add(this.normalize(path));
  }

  /** Cheap approximation: read-ish commands that name a file. */
  noteBash(command: string): void {
    if (!/\b(cat|head|tail|sed|nl|bat|less|more|awk)\b/.test(command)) return;
    for (const token of command.split(/[\s;|&()<>]+/)) {
      if (!token || token.startsWith("-")) continue;
      if (/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|c|h|cc|cpp|java|kt|rb|php|sh|json|md|css|html|toml|yaml|yml)$/i.test(token)) {
        this.seen.add(this.normalize(token.replace(/^["']|["']$/g, "")));
      }
    }
  }

  /** Null when allowed, else the reason to hand back to the model. */
  blockReason(path: string): string | null {
    if (this.seen.has(this.normalize(path))) return null;
    return `read ${path} before editing it. edit replaces exact text, and a file edited from memory is how content silently disappears. Call read (or cat it) first, then retry the edit.`;
  }
}
