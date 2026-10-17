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
 *   harness doctor             Configuration/backend diagnostics
 */

import { execFileSync } from "node:child_process";
import { loadConfig, type HarnessConfig } from "./config.js";
import { createHarnessSession, type HarnessSession, type NormalizedEvent } from "./pi/session.js";
import {
  runTask as controllerRunTask,
  formatStatus,
} from "./task/controller.js";
import { findActiveTask, listTaskIds, loadTask, saveTask } from "./task/store.js";
import type { TaskCheck } from "./task/types.js";

// ─── Argument parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  command: "interactive" | "run" | "task" | "resume" | "status" | "doctor";
  task?: string;
  checks: string[];
  provider?: string;
  model?: string;
  cwd?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { command: "interactive", checks: [] };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
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
        if (result.task === undefined && (result.command === "run" || result.command === "task" || result.command === "resume" || result.command === "status")) {
          result.task = arg; // goal for run/task; task id for resume/status
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
piharness — Lean Pi Coding Harness

Usage:
  harness                        Start interactive session
  harness run "task description" Run a one-shot task (no controller)
  harness task "goal"            Managed task with acceptance checks
  harness resume [id]            Resume an active managed task
  harness status [id]            Show task state (default: active task)
  harness doctor                 Check configuration and backend

Options:
  --provider <id>    Model provider (default: local)
  --model <id>       Model id (default: qwen38)
  --cwd <dir>        Working directory (default: .)
  --check "d|cmd"    Acceptance check: description, optional |verification command (repeatable)
  -h, --help         Show this help
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

// ─── One-shot task execution ───────────────────────────────────────────────────

async function runTask(config: HarnessConfig, task: string): Promise<void> {
  console.error(`\x1b[90mTask: ${task}\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model}\x1b[0m`);
  console.error(`\x1b[90mCWD: ${config.cwd}\x1b[0m\n`);

  const session = await createHarnessSession({
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
  });

  const handler = createStreamHandler(true);
  const unsub = session.subscribe(handler);

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

async function runManagedTask(
  config: HarnessConfig,
  goal: string,
  checks: TaskCheck[],
  resumeId?: string,
): Promise<void> {
  const mode = resumeId ? `resume ${resumeId}` : "new task";
  console.error(`\x1b[90mManaged ${mode}: ${goal}\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model} | CWD: ${config.cwd}\x1b[0m`);
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
      createSession: async (_prompt) =>
        createHarnessSession({
          cwd: config.cwd,
          provider: config.provider,
          model: config.model,
          thinkingLevel: config.thinkingLevel,
        }),
      runPrompt: async (session, prompt) => {
        const before = session.getSessionStats().toolCalls;
        const handler = createStreamHandler(true);
        const unsub = session.subscribe(handler);
        try {
          await session.prompt(prompt);
          await session.waitForIdle();
        } finally {
          unsub();
        }
        const after = session.getSessionStats().toolCalls;
        return { toolCalls: Math.max(0, after - before) };
      },
      disposeSession: (session) => session.dispose(),
      runCheck: async (check) => {
        if (!check.command) return { ok: true, output: "no command" };
        try {
          const out = execFileSync("/bin/sh", ["-c", check.command], {
            cwd: config.cwd,
            timeout: 120_000,
            maxBuffer: 1024 * 1024,
            encoding: "utf-8",
          });
          return { ok: true, output: out.slice(-4000) };
        } catch (err) {
          return { ok: false, output: String(err).slice(-4000) };
        }
      },
    });

    console.error("\n\x1b[90m─── Managed task finished ───\x1b[0m");
    console.log(formatStatus(result.record));
    process.exitCode = result.record.phase === "completed" ? 0 : 1;
  } finally {
    process.off("SIGINT", onSigint);
  }
}

async function runInteractive(config: HarnessConfig): Promise<void> {
  const readline = await import("node:readline/promises");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  console.error(`\x1b[90mpiharness interactive session\x1b[0m`);
  console.error(`\x1b[90mModel: ${config.provider}/${config.model}\x1b[0m`);
  console.error(`\x1b[90mType a task, or /quit to exit, /cancel to abort.\x1b[0m\n`);

  const session = await createHarnessSession({
    cwd: config.cwd,
    provider: config.provider,
    model: config.model,
    thinkingLevel: config.thinkingLevel,
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
        console.error(`\x1b[90mTool calls: ${stats.toolCalls} | Tokens: ${stats.tokens.total}\x1b[0m`);
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

// ─── Doctor ────────────────────────────────────────────────────────────────────

async function runDoctor(config: HarnessConfig): Promise<void> {
  console.log("piharness doctor\n");

  // Check Node version
  const nodeMajor = parseInt(process.versions.node.split(".")[0]);
  console.log(`Node.js: ${process.versions.node} ${nodeMajor >= 22 ? "✓" : "✗ (need >= 22.19)"}`);

  // Check model availability
  try {
    const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
    const runtime = await ModelRuntime.create({ refreshOnCreate: false });
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
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  const config = loadConfig(
    {
      provider: args.provider,
      model: args.model,
      cwd: args.cwd,
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
    case "doctor":
      await runDoctor(config);
      break;
    case "interactive":
    default:
      await runInteractive(config);
      break;
  }
}

main().catch((err) => {
  console.error(`Fatal: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
