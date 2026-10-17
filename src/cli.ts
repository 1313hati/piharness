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
import { loadConfig, type HarnessConfig } from "./config.js";
import { createHarnessSession, type HarnessSession, type NormalizedEvent } from "./pi/session.js";
import {
  runTask as controllerRunTask,
  formatStatus,
} from "./task/controller.js";
import { findActiveTask, listTaskIds, loadTask, saveTask } from "./task/store.js";
import type { TaskCheck, TaskLimits } from "./task/types.js";
import {
  buildContextBlock,
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
  command: "interactive" | "run" | "task" | "resume" | "status" | "memory" | "skill" | "eval" | "doctor";
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
      case "skill":
        result.command = "skill";
        break;
      case "eval":
        result.command = "eval";
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
        if (result.task === undefined && (result.command === "run" || result.command === "task" || result.command === "resume" || result.command === "status" || result.command === "memory" || result.command === "skill" || result.command === "eval")) {
          result.task = arg; // goal for run/task; id for resume/status; subcommand for memory/skill/eval
        } else if (result.task !== undefined && (result.command === "memory" || result.command === "skill" || result.command === "eval")) {
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
piharness — Lean Pi Coding Harness

Usage:
  harness                        Start interactive session
  harness run "task description" Run a one-shot task (no controller)
  harness task "goal"            Managed task with acceptance checks
  harness resume [id]            Resume an active managed task
  harness status [id]            Show task state (default: active task)
  harness memory list            List project memory facts
  harness memory add "fact"      Add a memory fact (tags via --tag, --source user|verified)
  harness memory remove <id>     Remove a memory fact
  harness skill propose <taskId> Draft a skill proposal from a completed task
  harness skill list             List skill proposals (inert until approved)
  harness skill show <name>      Show a proposal's SKILL.md draft
  harness skill evaluate <name>  Run the proposal's verify commands
  harness skill approve <name>   Promote a passed proposal into .harness/skills/
  harness skill reject <name>    Reject a proposal
  harness eval list              List evaluation scenarios (evals/scenarios/)
  harness eval run <name>        Run one scenario into .harness/state/evals/
  harness eval run --all         Run every scenario
  harness eval run <name> --dry-run   Validate a scenario without calling a model
  harness eval run <name> --no-skills  Baseline arm: same run with learned skills withheld
  harness eval score [name]      Pass rate and cost across recorded runs, per arm
  harness doctor                 Check configuration and backend

Options:
  --provider <id>    Model provider (default: local)
  --model <id>       Model id (default: qwen38)
  --cwd <dir>        Working directory (default: .)
  --check "d|cmd"    Acceptance check: description, optional |verification command (repeatable)
  --tag <t>          Tag for memory add (repeatable)
  --source <s>       Source for memory add: user|verified
  --dry-run          eval run: validate the scenario, execute nothing
  --all              eval run: every scenario
  --no-skills        eval run: omit .harness/skills from the run workspace (baseline arm)
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
        console.log(
          `  runs ${s.runs}  passed ${s.passed} (${Math.round(s.passRate * 100)}%)  ` +
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
        const proposals = listProposals(ws);
        if (proposals.length === 0) {
          console.log("No skill proposals. Draft one with: harness skill propose <taskId>");
          return;
        }
        for (const p of proposals) {
          const evalInfo = p.evalResult
            ? ` eval=${p.evalResult.passed ? "PASS" : "FAIL"}`
            : " eval=none";
          console.log(`${p.name}  [${p.status}]${evalInfo}  ${p.title.slice(0, 60)}`);
        }
        console.log(`\n${proposals.length} proposal(s) in .harness/state/proposals/ (inert until approved)`);
        return;
      }
      case "show": {
        if (!nameOrId) {
          console.error("Usage: harness skill show <name>");
          process.exit(1);
        }
        const p = loadProposal(ws, nameOrId);
        if (!p) {
          console.error(`No proposal named ${nameOrId}`);
          process.exit(1);
        }
        console.log(renderSkillMd(p));
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
        console.error("Usage: harness skill propose <taskId> | list | show <name> | evaluate <name> | approve <name> | reject <name>");
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
    case "memory":
      runMemory(config, args);
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
      await runInteractive(config);
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
