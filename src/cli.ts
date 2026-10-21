#!/usr/bin/env node
/**
 * piharness CLI entry point.
 *
 * Commands:
 *   harness                    Interactive session
 *   harness run "task"         One-shot task execution (no controller)
 *   harness task "goal"        Managed task with acceptance checks (M2)
 *   harness resume [id]        Resume an active managed task
 *   harness status [id]        Show task state (or the active task)
 *   harness memory <list|add|remove>   Manage project memory facts (M3)
 *   harness skill <propose|list|show|evaluate|approve|reject>   Learning service (M4)
 *   harness eval <list|run|score>   Evaluation scenarios and history (M5/M6)
 *   harness doctor             Configuration/backend diagnostics
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectStaleBuild, formatStaleBuild } from "./build-info.js";
import { loadConfig, type HarnessConfig } from "./config.js";
import { ensureAgentDir, outputBudget } from "./pi/agent-dir.js";
import { createHarnessSession, type HarnessSession, type NormalizedEvent } from "./pi/session.js";
import { deriveEvidence, listEvidence, loadEvidence } from "./learn/evidence.js";
import { loadSettings, renderSettings, setSetting, settingsPath } from "./config/settings.js";
import { clearLiveState, describeLive, readLiveState } from "./ui/live.js";
import { defaultAgentDir } from "./pi/agent-dir.js";
import type { TranscriptBlock } from "./ui/blocks.js";
import { DEFAULT_MIN_EVIDENCE, learnFromSession } from "./learn/mine.js";
import { createBuiltinExtensions, type BuiltinResult } from "./extensions/builtin.js";
import {
  addTodo, clearDoneTodos, completeTodo, loadTodos, removeTodo, reopenTodo, renderTodos,
} from "./extensions/todo.js";
import { globalMemoryPath, loadMemoryFile, memoryPath, renderFacts } from "./context/memory.js";
import { formatContext, formatTokens } from "./ui/stats.js";
import {
  runTask as controllerRunTask,
  formatStatus,
} from "./task/controller.js";
import { findActiveTask, listTaskIds, loadTask, saveTask } from "./task/store.js";
import type { TaskCheck, TaskLimits } from "./task/types.js";
import {
  buildContextBlock,
  globalSkillsRoot,
  listSkills,
  loadMemory,
  addFact,
  removeFact,
  MemoryError,
} from "./context/index.js";
import {
  listProposals,
  loadProposal,
  renderSkillMd,
  proposeFromTask,
  evaluateProposal,
  approveProposal,
  rejectProposal,
  SkillError,
} from "./skills/index.js";
import {
  EvalError,
  findScenario,
  listScenarios,
  readHistory,
  runScenario,
  summarizeHistory,
  type ScenarioRunner,
} from "./eval/index.js";

// ─── Argument parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  command: "interactive" | "run" | "task" | "resume" | "status" | "memory" | "todo" | "skill" | "eval" | "learn" | "settings" | "ps" | "doctor";
  task?: string;
  /** Positional args after the first (e.g. the fact text in memory add). */
  extras: string[];
  checks: string[];
  tags: string[];
  source?: "user" | "verified";
  provider?: string;
  model?: string;
  cwd?: string;
  /** eval run --dry-run: validate scenarios without calling a model. */
  dryRun?: boolean;
  /** eval run --all: run every scenario. */
  all?: boolean;
  /** eval run --no-skills: baseline arm with learned skills withheld. */
  noSkills?: boolean;
  noPromote?: boolean;
  /** ps: print machine-readable state. */
  json?: boolean;
  /** ps: remove a stale live state file. */
  clear?: boolean;
  /** Evidence needed before auto-promotion (default 2). */
  minEvidence?: number;
  thinkingLevel?: HarnessConfig["thinkingLevel"];
  /** interactive: force the line REPL instead of the TUI. */
  plain?: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { command: "interactive", checks: [], extras: [], tags: [] };
  const SUBCOMMAND_COMMANDS = new Set(["memory", "skill", "eval"]);

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    // `eval run …` / `skill list` — the subcommand must not be re-read as a
    // top-level command ("run" would otherwise restart task execution).
    if (!arg.startsWith("-") && SUBCOMMAND_COMMANDS.has(result.command)) {
      if (result.task === undefined) result.task = arg;
      else result.extras.push(arg);
      i += 1;
      continue;
    }
    switch (arg) {
      case "run":
        result.command = "run";
        break;
      case "task":
        result.command = "task";
        break;
      case "resume":
        result.command = "resume";
        break;
      case "status":
        result.command = "status";
        break;
      case "memory":
        result.command = "memory";
        break;
      case "todo":
        result.command = "todo";
        break;
      case "skill":
        result.command = "skill";
        break;
      case "eval":
        result.command = "eval";
        break;
      case "learn":
        result.command = "learn";
        break;
      case "settings":
        result.command = "settings";
        break;
      case "ps":
        result.command = "ps";
        break;
      case "doctor":
        result.command = "doctor";
        break;
      case "--provider":
        result.provider = args[++i];
        break;
      case "--model":
        result.model = args[++i];
        break;
      case "--cwd":
        result.cwd = args[++i];
        break;
      case "--check":
        result.checks.push(args[++i]);
        break;
      case "--dry-run":
        result.dryRun = true;
        break;
      case "--all":
        result.all = true;
        break;
      case "--no-skills":
        result.noSkills = true;
        break;
      case "--no-promote":
        result.noPromote = true;
        break;
      case "--json":
        result.json = true;
        break;
      case "--clear":
        result.clear = true;
        break;
      case "--min-evidence": {
        const v = Number(args[++i]);
        if (!Number.isFinite(v) || v < 1) {
          console.error("--min-evidence must be a positive number");
          process.exit(1);
        }
        result.minEvidence = v;
        break;
      }
      case "--thinking": {
        const v = args[++i];
        const levels = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
        if (!levels.includes(v)) {
          console.error(`--thinking must be one of ${levels.join("|")}`);
          process.exit(1);
        }
        result.thinkingLevel = v as HarnessConfig["thinkingLevel"];
        break;
      }
      case "--plain":
        result.plain = true;
        break;
      case "--tag":
        result.tags.push(args[++i]);
        break;
      case "--source": {
        const v = args[++i];
        if (v !== "user" && v !== "verified") {
          console.error('--source must be "user" or "verified"');
          process.exit(1);
        }
        result.source = v;
        break;
      }
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
        break;
      default:
        if (arg.startsWith("-")) {
          console.error(`Unknown option: ${arg}`);
          process.exit(1);
        }
        if (result.task === undefined && (result.command === "run" || result.command === "task" || result.command === "resume" || result.command === "status" || result.command === "memory" || result.command === "todo" || result.command === "skill" || result.command === "eval" || result.command === "learn" || result.command === "settings" || result.command === "ps")) {
          result.task = arg; // goal for run/task; id for resume/status; subcommand for memory/skill/eval
        } else if (result.task !== undefined && (result.command === "memory" || result.command === "todo" || result.command === "skill" || result.command === "eval" || result.command === "learn" || result.command === "settings" || result.command === "ps")) {
          result.extras.push(arg); // subcommand's arguments (ids/names)
        } else {
          console.error(`Unexpected argument: ${arg}`);
          process.exit(1);
        }
        break;
    }
    i++;
  }

  return result;
}

function printHelp(): void {
  console.log(`
piharness — Pi-based coding harness

Usage:
  piharness                         Interactive TUI (black + orange)
  piharness --plain                 Interactive line REPL instead of the TUI
  piharness run "task"              One-shot task (no controller)
  piharness task "goal"             Managed task with acceptance checks
  piharness resume [id]             Resume an active managed task
  piharness status [id]             Show task state (default: active task)
  piharness todo list [--all]       Open todos in this workspace (persisted)
  piharness todo add "text"         Add a todo
  piharness todo done <id>          Mark a todo done
  piharness memory list             List project memory facts
  piharness memory add "fact"       Add a memory fact (--tag, --source user|verified)
  piharness memory remove <id>      Remove a memory fact
  piharness ps [--json] [--clear]   Is the running session alive? What is it doing?
  piharness settings [show]         Show user settings
  piharness settings set <k> <v>    ui.gpu | learn.onExit | learn.autoPromote | learn.minEvidence
  piharness learn [id] [--dry-run]  Mine stored sessions into skill proposals
  piharness learn list              What has been learned, and how much evidence
  piharness skill propose <taskId>  Draft a skill proposal from a completed task
  piharness skill list              List skill proposals (inert until approved)
  piharness skill show <name>       Show a proposal's SKILL.md draft
  piharness skill evaluate <name>   Run the proposal's verify commands
  piharness skill approve <name>    Promote a passed proposal into .harness/skills/
  piharness skill reject <name>     Reject a proposal
  piharness eval list               List evaluation scenarios (evals/scenarios/)
  piharness eval run <name>         Run one scenario into .harness/state/evals/
  piharness eval run --all          Run every scenario
  piharness eval run <name> --dry-run    Validate a scenario without calling a model
  piharness eval run <name> --no-skills  Baseline arm: learned skills withheld
  piharness eval score [name]       Pass rate and cost per arm
  piharness doctor                  Check configuration and backend

Options:
  --plain            Interactive mode without the TUI (line REPL)
  --provider <id>    Model provider (default: local)
  --model <id>       Model id (default: qwen38)
  --cwd <dir>        Working directory (default: .)
  --thinking <level> Reasoning: off|minimal|low|medium|high|xhigh|max (default: medium)
  --check "d|cmd"    Acceptance check: description, optional |verification command
  --tag <t>          Tag for memory add (repeatable)
  --source <s>       Source for memory add: user|verified
  --dry-run          eval run: validate the scenario, execute nothing
  --all              eval run: every scenario
  --no-skills        eval run: omit .harness/skills (baseline arm)
  -v, --version      Print version
  -h, --help         Show this help

Isolation: this binary keeps its Pi state in ~/.config/piharness/agent (override
with PIHARNESS_AGENT_DIR). Your pi install and ~/.pi are never written to.
`);
}

// ─── Streaming output ──────────────────────────────────────────────────────────

function createStreamHandler(verbose: boolean = true) {
  let currentToolName = "";

  return (event: NormalizedEvent) => {
    switch (event.type) {
      case "text_delta":
        process.stdout.write(event.text);
        break;
      case "thinking_delta":
        if (verbose) {
          process.stdout.write(`\x1b[90m${event.text}\x1b[0m`);
        }
        break;
      case "tool_start":
        currentToolName = event.toolName;
        if (verbose) {
          const argsStr = JSON.stringify(event.args)?.slice(0, 120) ?? "";
          process.stdout.write(`\n\x1b[36m⚙ ${event.toolName}\x1b[0m ${argsStr}\n`);
        }
        break;
      case "tool_end":
        if (verbose) {
          const status = event.isError ? "\x1b[31m✗\x1b[0m" : "\x1b[32m✓\x1b[0m";
          process.stdout.write(`${status} ${event.toolName} done\n`);
        }
        break;
      case "error":
        process.stderr.write(`\n\x1b[31mError: ${event.message}\x1b[0m\n`);
        break;
      case "agent_start":
        if (verbose) process.stderr.write("\x1b[90m[agent started]\x1b[0m\n");
        break;
      case "agent_end":
        if (verbose) {
          process.stderr.write(`\x1b[90m[agent ${event.aborted ? "aborted" : "finished"}]\x1b[0m\n`);
        }
        break;
      default:
        break;
    }
  };
}

// ─── Extensions ────────────────────────────────────────────────────────────────

/**
 * Built-in extensions for a workspace: todos, memory, web, code navigation.
 * Evaluation runs deliberately do NOT get these, so scenario results stay
 * comparable with the recorded benchmark; interactive use gets everything.
 */
function builtinExtensions(cwd: string): BuiltinResult & { agentDir: string } {
  const agent = ensureAgentDir();
  const built = createBuiltinExtensions({ cwd, agentDir: agent.dir });
  return { ...built, agentDir: agent.dir };
}

// ─── One-shot task execution ───────────────────────────────────────────────────

/** One-line description of a tool call, for evidence (path or command). */
function describeCall(args: unknown): string {
  if (!args || typeof args !== "object") return "";
  const a = args as Record<string, unknown>;
  for (const key of ["command", "path", "file_path", "filePath", "pattern", "url", "query"]) {
    const v = a[key];
    if (typeof v === "string" && v.trim()) return v.replace(/\s+/g, " ").trim().slice(0, 160);
  }
  try {
    const json = JSON.stringify(a);
    return json === "{}" ? "" : json.slice(0, 160);
  } catch {
    return "";
  }
}

/**
 * Record a one-shot run as transcript blocks so the learning loop sees exactly
 * what the interactive TUI would have seen.
 */
function recordRun(session: HarnessSession, goal: string): TranscriptBlock[] {
  const blocks: TranscriptBlock[] = [{ kind: "user", text: goal }];
  const byId = new Map<string, number>();
  session.subscribe((event) => {
    if (event.type === "tool_start") {
      byId.set(event.toolCallId, blocks.length);
      blocks.push({ kind: "tool", name: event.toolName, detail: describeCall(event.args), status: "running", output: [], truncated: false });
      return;
    }
    if (event.type === "tool_end") {
      const at = byId.get(event.toolCallId);
      if (at === undefined) return;
      const block = blocks[at];
      if (block.kind !== "tool") return;
      block.status = event.isError ? "error" : "ok";
    }
  });
  return blocks;
}

async function runTask(config: HarnessConfig, task: string): Promise<void> {
  console.error(`\x1b[90mTask: ${task}\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model}\x1b[0m`);
  console.error(`\x1b[90mCWD: ${config.cwd}\x1b[0m\n`);

  const session = await createHarnessSession({
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    harnessExtensions: builtinExtensions(config.cwd).extensions,
  });

  const handler = createStreamHandler(true);
  const unsub = session.subscribe(handler);
  const evidenceBlocks = recordRun(session, task);

  // Cancellation
  const onSigint = () => {
    console.error("\n\x1b[33mCancelled — aborting...\x1b[0m");
    session.abort().finally(() => {
      unsub();
      session.dispose();
      process.exit(130);
    });
  };
  process.on("SIGINT", onSigint);

  try {
    await session.prompt(task);
    await session.waitForIdle();

    // Final report
    const stats = session.getSessionStats();
    const lastText = session.getLastAssistantText();
    console.error(`\n\x1b[90m─── Task complete ───\x1b[0m`);
    console.error(`\x1b[90mTool calls: ${stats.toolCalls} | Tokens: ${stats.tokens.total}\x1b[0m`);
    if (lastText) {
      console.error(`\n\x1b[32mFinal response:\x1b[0m\n${lastText}`);
    }
    reportLearning(config.cwd, evidenceBlocks);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n\x1b[31mTask failed: ${msg}\x1b[0m`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onSigint);
    unsub();
    session.dispose();
  }
}

// ─── Interactive session ───────────────────────────────────────────────────────

// ─── Managed tasks (M2 task controller) ─────────────────────────────────────

function parseCheck(raw: string, index: number): TaskCheck {
  const sep = raw.indexOf("|");
  const description = (sep === -1 ? raw : raw.slice(0, sep)).trim();
  const command = sep === -1 ? undefined : raw.slice(sep + 1).trim() || undefined;
  if (!description) {
    console.error(`Invalid --check: "${raw}" (need a non-empty description)`);
    process.exit(1);
  }
  return { id: `c${index + 1}`, description, command };
}

function resolveTask(config: HarnessConfig, id?: string) {
  if (id) return loadTask(config.cwd, id);
  return findActiveTask(config.cwd);
}

// ─── Managed task execution ────────────────────────────────────────────────────

/** Run one prompt on a session, streaming events, and report tool calls used. */
async function streamedRunPrompt(
  session: HarnessSession,
  prompt: string,
): Promise<{ toolCalls: number }> {
  const before = session.getSessionStats().toolCalls;
  const unsub = session.subscribe(createStreamHandler(true));
  try {
    await session.prompt(prompt);
    await session.waitForIdle();
  } finally {
    unsub();
  }
  const after = session.getSessionStats().toolCalls;
  return { toolCalls: Math.max(0, after - before) };
}

/** Run one acceptance-check command in `workspace`; never throws. */
function shellCheckRunner(workspace: string) {
  return async (check: TaskCheck): Promise<{ ok: boolean; output: string }> => {
    if (!check.command) return { ok: true, output: "no command" };
    try {
      const out = execFileSync("/bin/sh", ["-c", check.command], {
        cwd: workspace,
        timeout: 120_000,
        maxBuffer: 1024 * 1024,
        encoding: "utf-8",
      });
      return { ok: true, output: out.slice(-4000) };
    } catch (err) {
      return { ok: false, output: String(err).slice(-4000) };
    }
  };
}

async function runManagedTask(
  config: HarnessConfig,
  goal: string,
  checks: TaskCheck[],
  resumeId?: string,
): Promise<void> {
  const mode = resumeId ? `resume ${resumeId}` : "new task";
  console.error(`\x1b[90mManaged ${mode}: ${goal}\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model} | CWD: ${config.cwd}\x1b[0m`);
  // M3: inject relevant memory facts + skills into the implementation prompt.
  let contextBlock = "";
  try {
    contextBlock = buildContextBlock(config.cwd, goal);
  } catch (e) {
    if (e instanceof MemoryError) {
      console.error(`\x1b[31mMemory unusable (${e.message}); continuing without injected context.\x1b[0m`);
    } else {
      throw e;
    }
  }
  if (contextBlock) {
    console.error("\x1b[90mContext: memory facts and/or skills selected for this goal.\x1b[0m");
  }
  for (const c of checks) {
    console.error(`\x1b[90mCheck ${c.id}: ${c.description}${c.command ? ` (verify: ${c.command})` : ""}\x1b[0m`);
  }
  console.error("");

  // SIGINT: mark the active record cancelled so a later `harness resume` sees it.
  const onSigint = () => {
    const active = findActiveTask(config.cwd);
    if (active && (!resumeId || active.id === resumeId)) {
      active.phase = "cancelled";
      active.outcome = "Cancelled by user (SIGINT).";
      active.nextAction = "Re-run with: harness resume " + active.id;
      saveTask(config.cwd, active);
    }
    console.error("\n\x1b[33mCancelled — aborting...\x1b[0m");
    process.exit(130);
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await controllerRunTask({
      workspace: config.cwd,
      goal,
      checks,
      limits: {
        maxToolCalls: config.maxToolCalls,
        maxTaskMinutes: config.maxTaskMinutes,
        maxRepairCycles: config.maxRepairCycles,
      },
      model: `${config.provider}/${config.model}`,
      resumeId,
      contextBlock: contextBlock || undefined,
      createSession: async (_prompt) =>
        createHarnessSession({
          cwd: config.cwd,
          provider: config.provider,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
          harnessExtensions: builtinExtensions(config.cwd).extensions,
        }),
      runPrompt: async (session, prompt) => streamedRunPrompt(session, prompt),
      disposeSession: (session) => session.dispose(),
      runCheck: shellCheckRunner(config.cwd),
    });

    console.error("\n\x1b[90m─── Managed task finished ───\x1b[0m");
    console.log(formatStatus(result.record));
    process.exitCode = result.record.phase === "completed" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function runInteractive(config: HarnessConfig, plain = false): Promise<void> {
  const tty = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  if (plain || !tty) {
    return runPlainRepl(config);
  }

  const { runTui } = await import("./ui/app.js");
  const ext = builtinExtensions(config.cwd);
  const session = await createHarnessSession({
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    harnessExtensions: ext.extensions,
  });
  try {
    const blocks = await runTui({
      session,
      provider: config.provider,
      model: config.model,
      cwd: config.cwd,
      workspace: config.cwd,
      agentDir: ext.agentDir,
      toolNames: ext.toolNames,
      extensionInfo: () => session.getExtensionInfo(),
      thinkingLevel: config.thinkingLevel,
    });
    reportLearning(config.cwd, blocks);
  } finally {
    session.dispose();
  }
}

/**
 * Learning after a session: derive evidence from what really happened, then
 * propose / reinforce / promote. Never throws into the caller — a broken
 * learning step must not turn a good session into a failed one.
 */
function reportLearning(cwd: string, blocks: TranscriptBlock[]): void {
  const settings = loadSettings(defaultAgentDir());
  if (process.env.PIHARNESS_NO_LEARN === "1" || !settings.learn.onExit) return;
  try {
    const evidence = deriveEvidence(blocks, { cwd });
    if (!evidence) return;
    const result = learnFromSession(cwd, evidence, {
      autoPromote: process.env.PIHARNESS_AUTO_PROMOTE !== undefined
        ? process.env.PIHARNESS_AUTO_PROMOTE !== "0"
        : settings.learn.autoPromote,
      minEvidence: Number(process.env.PIHARNESS_MIN_EVIDENCE ?? settings.learn.minEvidence ?? DEFAULT_MIN_EVIDENCE),
    });
    if (result.action === "none") return;
    const icon = result.action === "promoted" ? "★" : "◇";
    console.error(`\x1b[33m${icon} learn: ${result.action} ${result.name}\x1b[0m — ${result.reason}`);
  } catch (err) {
    console.error(`\x1b[90mlearn: skipped (${err instanceof Error ? err.message : String(err)})\x1b[0m`);
  }
}

/** Line-based fallback for pipes, dumb terminals, and `--plain`. */
async function runPlainRepl(config: HarnessConfig): Promise<void> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.error(`\x1b[90mpiharness interactive session\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model}\x1b[0m`);
  console.error(`\x1b[90mType a task, or /quit to exit, /cancel to abort.\x1b[0m\n`);

  const ext = builtinExtensions(config.cwd);
  const session = await createHarnessSession({
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
    harnessExtensions: ext.extensions,
  });

  const handler = createStreamHandler(true);
  const unsub = session.subscribe(handler);

  // Cancellation
  const onSigint = () => {
    if (session.isStreaming) {
      console.error("\n\x1b[33mCancelling current task...\x1b[0m");
      session.abort();
    } else {
      rl.close();
      unsub();
      session.dispose();
      process.exit(0);
    }
  };
  process.on("SIGINT", onSigint);

  try {
    while (true) {
      const input = await rl.question("\x1b[34m❯\x1b[0m ");
      const trimmed = input.trim();
      if (!trimmed) continue;

      if (trimmed === "/quit" || trimmed === "/exit") break;
      if (trimmed === "/cancel") {
        await session.abort();
        continue;
      }
      if (trimmed === "/stats") {
        const stats = session.getSessionStats();
        const ctx = session.getContextUsage();
        console.error(
          `\x1b[90mtools ${stats.toolCalls} | tokens ${stats.tokens.total} (${stats.tokens.input} in / ${stats.tokens.output} out) | ` +
            `${formatContext(ctx) || "ctx unknown"} | session ${session.sessionId}\x1b[0m`,
        );
        continue;
      }
      if (trimmed === "/compact" || trimmed.startsWith("/compact ")) {
        const instructions = trimmed.slice("/compact".length).trim();
        try {
          const res = await session.compact(instructions || undefined);
          console.error(
            `\x1b[90mcompacted: ${formatTokens(res.tokensBefore)} → ${formatTokens(res.estimatedTokensAfter ?? 0)} tokens\x1b[0m`,
          );
        } catch (err) {
          console.error(`\x1b[31mcompaction failed: ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
        continue;
      }
      if (trimmed === "/todos" || trimmed.startsWith("/todos ")) {
        const arg = trimmed.slice("/todos".length).trim();
        const [verb, ...rest] = arg.split(/\s+/).filter(Boolean);
        const text = rest.join(" ").trim();
        try {
          if (!verb) {
            console.error(renderTodos(loadTodos(config.cwd), { limit: 50 }) || "\x1b[90m(no open todos)\x1b[0m");
          } else if (verb === "add" && text) {
            const item = addTodo(config.cwd, text);
            console.error(`added ${item.id}: ${item.text}`);
          } else if (verb === "done" && text) {
            const item = completeTodo(config.cwd, text);
            console.error(item ? `done ${item.id}` : `no todo matches ${JSON.stringify(text)}`);
          } else if ((verb === "rm" || verb === "remove") && text) {
            const item = removeTodo(config.cwd, text);
            console.error(item ? `removed ${item.id}` : `no todo matches ${JSON.stringify(text)}`);
          } else {
            console.error("usage: /todos [add|done|rm] <text>");
          }
        } catch (err) {
          console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
        continue;
      }
      if (trimmed === "/memory" || trimmed.startsWith("/memory ")) {
        const arg = trimmed.slice("/memory".length).trim();
        try {
          if (arg.startsWith("add ")) {
            const fact = addFact(config.cwd, arg.slice(4).trim());
            console.error(`remembered ${fact.id}: ${fact.fact}`);
          } else {
            const project = renderFacts(loadMemoryFile(memoryPath(config.cwd)).facts, 50, 4000);
            const global = renderFacts(loadMemoryFile(globalMemoryPath(ext.agentDir)).facts, 50, 4000);
            console.error(`\x1b[90mproject:\x1b[0m\n${project || "(empty)"}\n\x1b[90mglobal:\x1b[0m\n${global || "(empty)"}`);
          }
        } catch (err) {
          console.error(`\x1b[31m${err instanceof Error ? err.message : String(err)}\x1b[0m`);
        }
        continue;
      }
      if (trimmed === "/extensions") {
        console.error(`tools: ${ext.toolNames.join(", ")}`);
        const info = session.getExtensionInfo();
        console.error(`loaded: ${info.paths.join(", ") || "built-ins only"}`);
        for (const d of info.diagnostics) console.error(`\x1b[31m${d}\x1b[0m`);
        continue;
      }

      try {
        await session.prompt(trimmed);
        await session.waitForIdle();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`\x1b[31mError: ${msg}\x1b[0m`);
      }
    }
  } finally {
    process.off("SIGINT", onSigint);
    rl.close();
    unsub();
    session.dispose();
  }
}

// ─── Evaluation scenarios (M5) ─────────────────────────────────────────────────

/** Real scenario runner: one managed task in the run's own workspace copy. */
function makeScenarioRunner(config: HarnessConfig): ScenarioRunner {
  return async ({ workspace, goal, checks, limits, model }) => {
    let contextBlock = "";
    try {
      contextBlock = buildContextBlock(workspace, goal);
    } catch (e) {
      if (!(e instanceof MemoryError)) throw e;
      console.error(`\x1b[31mMemory unusable (${e.message}); running without injected context.\x1b[0m`);
    }
    return controllerRunTask({
      workspace,
      goal,
      checks,
      limits,
      model,
      contextBlock: contextBlock || undefined,
      createSession: async () =>
        createHarnessSession({
          cwd: workspace,
          provider: config.provider,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
        }),
      runPrompt: (session, prompt) => streamedRunPrompt(session, prompt),
      disposeSession: (session) => session.dispose(),
      runCheck: shellCheckRunner(workspace),
    });
  };
}

async function runEval(config: HarnessConfig, args: CliArgs): Promise<void> {
  const sub = args.task;
  const name = args.extras[0];
  const repoRoot = config.cwd;
  try {
    if (sub === "list") {
      const scenarios = listScenarios(repoRoot);
      if (scenarios.length === 0) {
        console.log("No scenarios in evals/scenarios/.");
        return;
      }
      for (const s of scenarios) {
        console.log(`${s.name}  ${s.description || "(no description)"}`);
        console.log(`  fixture: ${s.fixture}`);
        for (const c of s.checks) {
          console.log(`  check ${c.id}: ${c.description}${c.command ? ` (verify: ${c.command})` : ""}`);
        }
      }
      console.log(`\n${scenarios.length} scenario(s) in evals/scenarios/`);
      return;
    }
    if (sub === "score") {
      const entries = readHistory(repoRoot);
      if (entries.length === 0) {
        console.log("No evaluation history yet (run: harness eval run <name>).");
        return;
      }
      const filtered = name ? entries.filter((e) => e.scenario === name) : entries;
      const summaries = summarizeHistory(filtered);
      if (summaries.length === 0) {
        console.error(`No history for scenario ${name}.`);
        process.exit(1);
      }
      for (const s of summaries) {
        // `—` means "no run produced cost data" (e.g. every run failed to reach
        // the backend) — printing 0 there reads as a perfect free run.
        const num = (v: number | null, digits = 0) =>
          v === null ? "—" : digits > 0 ? v.toFixed(digits) : String(v);
        console.log(`${s.scenario} [${s.variant}]`);
        const preModel = s.runs - s.modelRuns;
        console.log(
          `  runs ${s.runs}  passed ${s.passed} (${Math.round(s.passRate * 100)}% of ${s.modelRuns} that reached the model` +
            `${preModel > 0 ? `; ${preModel} pre-backend` : ""})  ` +
            `best tools ${num(s.bestToolCalls)}  avg tools ${num(s.avgToolCalls, 1)}  best ${num(s.bestSeconds)}s`,
        );
        console.log(
          `  last: ${s.last.at}  ${s.last.passed ? "PASS" : "FAIL"}  phase=${s.last.phase}  ${s.last.model}`,
        );
        console.log(`  evidence: ${s.last.runDir}`);
      }
      return;
    }
    if (sub !== "run") {
      console.error("Usage: harness eval list | run <name> | run --all | score [name] [--dry-run]");
      process.exit(1);
    }

    let targets;
    if (args.all) {
      targets = listScenarios(repoRoot);
      if (targets.length === 0) {
        console.error("No scenarios to run.");
        process.exit(1);
      }
    } else {
      if (!name) {
        console.error("Usage: harness eval run <name> | run --all");
        process.exit(1);
      }
      const found = findScenario(repoRoot, name);
      if (!found) {
        console.error(`No scenario named ${name} (see: harness eval list)`);
        process.exit(1);
      }
      targets = [found];
    }

    if (args.dryRun) {
      for (const s of targets) {
        console.log(`dry-run ${s.name}`);
        console.log(`  fixture: ${s.fixtureDir}`);
        console.log(`  goal: ${s.goal}`);
        console.log(
          `  limits: ${JSON.stringify(s.limits)} (harness defaults: tools ${config.maxToolCalls}, ` +
            `${config.maxTaskMinutes}m, repairs ${config.maxRepairCycles})`,
        );
      }
      console.log(`\n${targets.length} scenario(s) valid; nothing executed.`);
      return;
    }

    const runner = makeScenarioRunner(config);
    const variant = args.noSkills ? "no-skills" : "skills";
    const runs = [];
    for (const s of targets) {
      console.error(`\n\x1b[90m─── eval ${s.name} (${variant}) ───\x1b[0m`);
      const run = await runScenario({
        repoRoot,
        scenario: s,
        model: `${config.provider}/${config.model}`,
        runner,
        variant,
        defaults: {
          maxToolCalls: config.maxToolCalls,
          maxTaskMinutes: config.maxTaskMinutes,
          maxRepairCycles: config.maxRepairCycles,
        },
      });
      runs.push(run);
      const m = run.manifest;
      console.log(
        `${m.passed ? "PASS" : "FAIL"} ${m.scenario} [${m.variant}]  phase=${m.phase} ` +
          `tools=${m.budgets.toolCallsUsed} repairs=${m.budgets.repairCyclesUsed} ` +
          `${Math.round(m.durationMs / 1000)}s`,
      );
      if (m.outcome) console.log(`  outcome: ${m.outcome}`);
      console.log(`  evidence: ${run.runDir}`);
    }
    const failed = runs.filter((r) => !r.manifest.passed);
    console.log(`\n${runs.length - failed.length}/${runs.length} scenario(s) passed`);
    if (failed.length > 0) process.exitCode = 1;
  } catch (e) {
    if (e instanceof EvalError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

/**
 * `piharness learn` — mine stored sessions that no proposal has claimed yet.
 * `list` shows what has been learned and how much evidence stands behind it.
 */
/** `piharness ps` — is the running session alive, and what is it doing? */
function runPs(args: CliArgs): void {
  const agentDir = defaultAgentDir();
  if (args.clear) {
    clearLiveState(agentDir);
    console.log("cleared live state");
    return;
  }
  const live = readLiveState(agentDir);
  if (!live) {
    console.log("no live harness session");
    return;
  }
  console.log(args.json ? JSON.stringify(live.state, null, 2) : describeLive(live));
}

/** `piharness settings` — show or change user settings. */
function runSettings(args: CliArgs): void {
  const agentDir = defaultAgentDir();
  const sub = args.task ?? "show";
  if (sub === "show" || sub === "list") {
    console.log(renderSettings(loadSettings(agentDir), settingsPath(agentDir)).join("\n"));
    return;
  }
  if (sub === "set") {
    const key = args.extras[0];
    const value = args.extras.slice(1).join(" ").trim();
    if (!key || !value) {
      console.error("usage: piharness settings set <key> <value>");
      process.exit(1);
    }
    const result = setSetting(agentDir, key, value);
    if (!result.ok) {
      console.error(result.error);
      process.exit(1);
    }
    console.log(`${key} = ${value}`);
    return;
  }
  console.error(`unknown settings command "${sub}" (show|set)`);
  process.exit(1);
}

function runLearn(config: HarnessConfig, args: CliArgs): void {
  const sub = args.task;
  if (sub === "list") {
    const proposals = listProposals(config.cwd);
    if (proposals.length === 0) {
      console.log("No skill proposals yet. Run a session that changes files and verifies them, then: piharness learn");
      return;
    }
    for (const p of proposals) {
      const count = p.evidenceCount ?? p.evidenceSessions?.length ?? 0;
      const mark = p.status === "approved" ? "approved" : p.status === "rejected" ? "rejected" : "proposed";
      const auto = p.autoPromoted ? " · auto" : "";
      console.log(`${p.name}  [${mark}${auto}]  evidence=${count}  ${p.verifyCommands.join(", ") || "no verify"}`);
    }
    return;
  }

  const sessionId = sub && sub !== "all" ? sub : undefined;
  const all = sessionId ? [loadEvidence(config.cwd, sessionId)].filter((e): e is NonNullable<typeof e> => Boolean(e)) : listEvidence(config.cwd);
  if (sessionId && all.length === 0) {
    console.error(`No stored session "${sessionId}" (see .harness/state/sessions/)`);
    process.exit(1);
  }
  const claimed = new Set(listProposals(config.cwd).flatMap((p) => p.evidenceSessions ?? []));
  const pending = all.filter((e) => !claimed.has(e.id));
  if (pending.length === 0) {
    console.log(all.length === 0 ? "No sessions recorded yet." : "Nothing new to learn: every stored session already has a proposal.");
    return;
  }
  const autoPromote = !args.noPromote;
  const minEvidence = Number(
    args.minEvidence ?? process.env.PIHARNESS_MIN_EVIDENCE ?? loadSettings(defaultAgentDir()).learn.minEvidence ?? 2,
  );
  for (const evidence of pending) {
    const r = learnFromSession(config.cwd, evidence, { autoPromote, minEvidence, dryRun: args.dryRun });
    const goal = evidence.goals[0] ?? evidence.id;
    console.log(`${r.action.padEnd(10)} ${r.name ?? "-"}  ${r.reason}  — ${goal.slice(0, 60)}`);
  }
}

function runTodo(config: HarnessConfig, args: CliArgs): void {
  const sub = args.task;
  const text = args.extras.join(" ").trim();
  const ws = config.cwd;
  try {
    switch (sub) {
      case "list":
      case undefined: {
        const body = renderTodos(loadTodos(ws), { includeDone: args.all });
        console.log(body || "No open todos. Add one with: piharness todo add \"text\"");
        return;
      }
      case "add": {
        if (!text) {
          console.error('Usage: piharness todo add "text"');
          process.exit(1);
        }
        const item = addTodo(ws, text);
        console.log(`Added ${item.id}: ${item.text}`);
        return;
      }
      case "done":
      case "rm":
      case "remove":
      case "reopen": {
        if (!text) {
          console.error(`Usage: piharness todo ${sub} <id>`);
          process.exit(1);
        }
        const fn = sub === "done" ? completeTodo : sub === "reopen" ? reopenTodo : removeTodo;
        const item = fn(ws, text);
        if (!item) {
          console.error(`No unique todo matches ${JSON.stringify(text)}`);
          process.exit(1);
        }
        console.log(`${sub}: ${item.id} ${item.text}`);
        return;
      }
      case "clear":
      case "clear_done": {
        console.log(`Removed ${clearDoneTodos(ws)} finished todo(s)`);
        return;
      }
      default:
        console.error("Usage: piharness todo list [--all] | add \"text\" | done <id> | reopen <id> | rm <id> | clear");
        process.exit(1);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}

function runMemory(config: HarnessConfig, args: CliArgs): void {
  const sub = args.task;
  const extras = args.extras;
  const ws = config.cwd;
  try {
    switch (sub) {
      case "list": {
        const mem = loadMemory(ws);
        if (mem.facts.length === 0) {
          console.log('No memory facts. Add one with: harness memory add "fact text" --tag t1 --tag t2');
          return;
        }
        for (const f of mem.facts) {
          const tags = f.tags.length ? ` (${f.tags.join(", ")})` : "";
          console.log(`${f.id}  [${f.source}]${tags}  ${f.fact}`);
        }
        console.log(`\n${mem.facts.length} fact(s) in .harness/memory.json`);
        return;
      }
      case "add": {
        const text = extras.join(" ").trim();
        if (!text) {
          console.error('Usage: harness memory add "fact text" [--tag t]... [--source user|verified]');
          process.exit(1);
        }
        const f = addFact(ws, text, { tags: args.tags, source: args.source ?? "user" });
        console.log(`Added ${f.id}: ${f.fact}`);
        return;
      }
      case "remove": {
        const id = extras[0];
        if (!id) {
          console.error("Usage: harness memory remove <id>");
          process.exit(1);
        }
        if (!removeFact(ws, id)) {
          console.error(`No memory fact with id ${id}`);
          process.exit(1);
        }
        console.log(`Removed ${id}`);
        return;
      }
      default:
        console.error("Usage: harness memory list | add \"fact\" [--tag t]... [--source user|verified] | remove <id>");
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof MemoryError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}
function runSkill(config: HarnessConfig, args: CliArgs): void {
  const sub = args.task;
  const nameOrId = args.extras[0];
  const ws = config.cwd;
  try {
    switch (sub) {
      case "propose": {
        if (!nameOrId) {
          console.error("Usage: harness skill propose <taskId>");
          process.exit(1);
        }
        const record = loadTask(ws, nameOrId);
        if (!record) {
          console.error(`No task with id ${nameOrId}`);
          process.exit(1);
        }
        const p = proposeFromTask(ws, record);
        console.log(`Proposed ${p.name} (from task ${record.id})`);
        console.log(`  draft: .harness/state/proposals/${p.name}/proposal.json`);
        console.log(`  next:  harness skill evaluate ${p.name} && harness skill approve ${p.name}`);
        return;
      }
      case "list": {
        // What is installed and usable now, before the proposals (which are
        // inert until approved) — the two are different questions.
        const installed = listSkills(ws);
        const global = globalSkillsRoot();
        if (installed.length === 0) {
          console.log("No approved skills in .harness/skills/ or " + global + "/");
        } else {
          for (const s of installed) {
            const where = `[${s.path.startsWith(global) ? "global" : "project"}]`.padEnd(10);
            const desc = s.description.length > 70 ? `${s.description.slice(0, 69)}…` : s.description;
            console.log(`${s.name}  ${where} ${desc}`);
          }
        }
        const proposals = listProposals(ws);
        if (proposals.length > 0) {
          console.log("");
          for (const p of proposals) {
            const evalInfo = p.evalResult
              ? ` eval=${p.evalResult.passed ? "PASS" : "FAIL"}`
              : " eval=none";
            console.log(`${p.name}  [${p.status}]${evalInfo}  ${p.title.slice(0, 60)}`);
          }
          console.log(`\n${proposals.length} proposal(s) in .harness/state/proposals/ (inert until approved)`);
        }
        return;
      }
      case "show": {
        if (!nameOrId) {
          console.error("Usage: harness skill show <name>");
          process.exit(1);
        }
        const p = loadProposal(ws, nameOrId);
        if (p) {
          console.log(renderSkillMd(p));
          return;
        }
        const approved = listSkills(ws).find((s) => s.name === nameOrId);
        if (!approved) {
          console.error(`No skill named ${nameOrId} (see: harness skill list)`);
          process.exit(1);
        }
        console.log(`File: ${approved.path}\n`);
        console.log(readFileSync(approved.path, "utf-8"));
        return;
      }
      case "evaluate": {
        if (!nameOrId) {
          console.error("Usage: harness skill evaluate <name>");
          process.exit(1);
        }
        const { manifest, passed } = evaluateProposal(ws, nameOrId);
        for (const c of manifest.commands) {
          console.log(`${c.ok ? "PASS" : "FAIL"}  ${c.command}`);
        }
        if (manifest.commands.length === 0) console.log("(no verify commands recorded)");
        console.log(`\nEvaluation: ${passed ? "PASS" : "FAIL"} — manifest in .harness/state/evals/`);
        process.exitCode = passed ? 0 : 1;
        return;
      }
      case "approve": {
        if (!nameOrId) {
          console.error("Usage: harness skill approve <name>");
          process.exit(1);
        }
        const p = approveProposal(ws, nameOrId);
        console.log(`Approved ${p.name} → .harness/skills/${p.name}/SKILL.md`);
        console.log("It is now discoverable by the context service.");
        return;
      }
      case "reject": {
        if (!nameOrId) {
          console.error("Usage: harness skill reject <name>");
          process.exit(1);
        }
        const p = rejectProposal(ws, nameOrId);
        console.log(`Rejected ${p.name} (kept in .harness/state/proposals/ for inspection)`);
        return;
      }
      default:
        console.error("Usage: harness skill list | show <name> | propose <taskId> | evaluate <name> | approve <name> | reject <name>");
        process.exit(1);
    }
  } catch (e) {
    if (e instanceof SkillError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

// ─── Doctor ────────────────────────────────────────────────────────────────────

async function runDoctor(config: HarnessConfig): Promise<void> {
  console.log("piharness doctor\n");

  // Check Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0]);
  console.log(`Node.js: ${process.versions.node} ${nodeMajor >= 22 ? "✓" : "✗ (need >= 22.19)"}`);

  // Check model availability
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const agent = ensureAgentDir();
    console.log(`Agent dir: ${agent.dir}${agent.seeded ? " (models.json seeded from ~/.pi)" : ""}`);
    const runtime = await ModelRuntime.create({
      authPath: join(agent.dir, "auth.json"),
      modelsPath: agent.modelsPath,
      refreshOnCreate: false,
    });
    const providers = runtime.getProviders();
    console.log(`Providers: ${providers.map((p) => p.id).join(", ")}`);

    const model = runtime.getModel(config.provider, config.model);
    if (model) {
      console.log(`Model ${config.provider}/${config.model}: ✓ found (ctx=${model.contextWindow}, max=${model.maxTokens})`);
    } else {
      console.log(`Model ${config.provider}/${config.model}: ✗ not found`);
      const allModels = runtime.getModels(config.provider);
      if (allModels.length > 0) {
        console.log(`  Available: ${allModels.map((m) => m.id).join(", ")}`);
      }
    }
  } catch (err) {
    console.log(`Model runtime: ✗ ${err instanceof Error ? err.message : String(err)}`);
  }

  // Check local endpoint
  if (config.provider === "local") {
    try {
      const resp = await fetch("http://127.0.0.1:8080/v1/models", { signal: AbortSignal.timeout(3000) });
      if (resp.ok) {
        console.log("Local endpoint http://127.0.0.1:8080: ✓ reachable");
      } else {
        console.log(`Local endpoint: ✗ HTTP ${resp.status}`);
      }
    } catch {
      console.log("Local endpoint http://127.0.0.1:8080: ✗ not reachable");
    }
  }

  console.log(`\nCWD: ${config.cwd}`);
  console.log(`Max tool calls: ${config.maxToolCalls}`);
  console.log(`Max task time: ${config.maxTaskMinutes}m`);
  console.log(`Command timeout: ${config.commandTimeoutSec}s`);
  console.log(`Reasoning: ${config.thinkingLevel} (thinkingLevel in .harness/config.json, /think in the TUI)`);
  console.log(`Output budget: ${outputBudget()} tokens per response (PIHARNESS_MAX_OUTPUT)`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

/**
 * Flush stdout, then exit. Needed because Pi's client can keep sockets and
 * timers alive after a failed run (observed after connection retries), which
 * otherwise leaves a one-shot CLI hanging.
 */
function shutdown(code: number): void {
  process.exitCode = code;
  const timer = setTimeout(() => process.exit(code), 250);
  timer.unref();
  process.stdout.write("", () => process.exit(code));
}

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/**
 * A checkout runs `dist/`, not `src/`: editing the sources changes nothing
 * until `npm run build`. That once meant a fixed bug was still on screen days
 * later, because the binary was a stale bundle. Say it once, on stderr, before
 * the TUI takes the screen. Installed packages have no `src/` and stay silent.
 */
function warnIfStaleBuild(): void {
  if (process.env.PIHARNESS_NO_STALE_WARNING) return;
  const entry = fileURLToPath(import.meta.url);
  if (!entry.endsWith(".js")) return; // running from src under tsx: not a bundle
  const stale = detectStaleBuild(entry, fileURLToPath(new URL("../src", import.meta.url)));
  if (stale) console.error(formatStaleBuild(stale));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  if (argv.includes("--version") || argv.includes("-v")) {
    console.log(`piharness ${packageVersion()}`);
    return;
  }

  warnIfStaleBuild();

  const args = parseArgs(process.argv);

  const config = loadConfig(
    {
      provider: args.provider,
      model: args.model,
      cwd: args.cwd,
      thinkingLevel: args.thinkingLevel,
    } as Partial<HarnessConfig>,
    args.cwd ?? process.cwd(),
  );

  switch (args.command) {
    case "run":
      if (!args.task) {
        console.error("Usage: harness run \"task description\"");
        process.exit(1);
      }
      await runTask(config, args.task);
      break;
    case "task": {
      if (!args.task) {
        console.error('Usage: harness task "goal" [--check "description|command" ...]');
        process.exit(1);
      }
      const checks = args.checks.map((c, i) => parseCheck(c, i));
      await runManagedTask(config, args.task, checks);
      break;
    }
    case "resume": {
      const record = resolveTask(config, args.task);
      if (!record) {
        console.error("Nothing to resume (no active task).");
        process.exit(1);
      }
      await runManagedTask(config, record.goal, record.checks, record.id);
      break;
    }
    case "status": {
      const record = resolveTask(config, args.task);
      if (!record) {
        const ids = listTaskIds(config.cwd);
        console.log(ids.length ? "No active task." : "No tasks recorded.");
        for (const id of ids) {
          try {
            const rec = loadTask(config.cwd, id);
            console.log(`  ${id}  ${rec.phase}  ${rec.goal.slice(0, 60)}`);
          } catch {
            console.log(`  ${id}  (unreadable)`);
          }
        }
        break;
      }
      console.log(formatStatus(record));
      break;
    }
    case "memory":
      runMemory(config, args);
      break;
    case "todo":
      runTodo(config, args);
      break;
    case "learn":
      runLearn(config, args);
      break;
    case "settings":
      runSettings(args);
      break;
    case "ps":
      runPs(args);
      break;
    case "skill":
      runSkill(config, args);
      break;
    case "eval":
      await runEval(config, args);
      break;
    case "doctor":
      await runDoctor(config);
      break;
    case "interactive":
    default:
      await runInteractive(config, args.plain);
      break;
  }
  // The Pi client keeps sockets/timers alive after a failed run; a one-shot
  // CLI must still terminate (observed after connection retries).
  shutdown(Number(process.exitCode ?? 0));
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
