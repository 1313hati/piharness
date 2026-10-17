#!/usr/bin/env node
/**
 * piharness CLI entry point.
 *
 * Commands:
 *   harness                    Interactive session
 *   harness run "task"         One-shot task execution
 *   harness doctor             Configuration/backend diagnostics
 */

import { loadConfig, type HarnessConfig } from "./config.js";
import { createHarnessSession, type HarnessSession, type NormalizedEvent } from "./pi/session.js";

// ─── Argument parsing ──────────────────────────────────────────────────────────

interface CliArgs {
  command: "interactive" | "run" | "doctor";
  task?: string;
  provider?: string;
  model?: string;
  cwd?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args = argv.slice(2);
  const result: CliArgs = { command: "interactive" };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case "run":
        result.command = "run";
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
        if (result.command === "run" && !result.task) {
          result.task = arg;
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
  harness run "task description" Run a one-shot task
  harness doctor                 Check configuration and backend

Options:
  --provider <id>    Model provider (default: local)
  --model <id>       Model id (default: qwen38)
  --cwd <dir>        Working directory (default: .)
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
