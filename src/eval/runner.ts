/**
 * Scenario runner (M5) — copy a fixture into a scratch workspace, run one
 * managed task there, and record the outcome as evidence under
 * `.harness/state/evals/<scenario>-<ts>/` (manifest.json + work/ tree).
 *
 * The task execution itself is injected (`ScenarioRunner`), so this module
 * never imports Pi and can be tested without a model.
 */

import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, relative } from "node:path";
import { atomicWriteJson } from "../fsutil.js";
import { listSkills } from "../context/skills.js";
import type { RunResult } from "../task/controller.js";
import type { TaskBudgets, TaskCheck, TaskLimits } from "../task/types.js";
import { EvalError, type Scenario } from "./scenarios.js";

export const SCENARIO_MANIFEST_VERSION = 1;

/** Runs one task in the given workspace. Injected by the CLI (real) or tests. */
export type ScenarioRunner = (opts: {
  workspace: string;
  goal: string;
  checks: TaskCheck[];
  limits: TaskLimits;
  model: string;
}) => Promise<RunResult>;

export interface ScenarioManifest {
  schemaVersion: number;
  kind: "scenario";
  scenario: string;
  at: string;
  fixture: string;
  /** Workspace the task ran in (repo-relative). */
  workspace: string;
  model: string;
  phase: string;
  passed: boolean;
  taskId: string;
  budgets: TaskBudgets;
  durationMs: number;
  checks: Array<{ id: string; description: string; command?: string }>;
  /** Skills that were available in the run workspace (injected context). */
  contextSkills: string[];
  validationResults: string[];
  outcome?: string;
}

export interface ScenarioRun {
  manifest: ScenarioManifest;
  /** Directory holding manifest.json and work/. */
  runDir: string;
}

/** Directories never copied out of a fixture. */
const COPY_SKIP = new Set([".git", "node_modules", ".harness"]);

export function evalsDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "state", "evals");
}

function copyFixture(fixtureDir: string, dest: string): void {
  cpSync(fixtureDir, dest, {
    recursive: true,
    dereference: false,
    filter: (src) => {
      const name = src.split("/").pop() ?? "";
      return !COPY_SKIP.has(name);
    },
  });
}

/** Copy learned context (facts + approved skills) so the run is self-contained. */
function copyContext(repoRoot: string, dest: string): void {
  const memory = join(repoRoot, ".harness", "memory.json");
  if (existsSync(memory)) {
    mkdirSync(join(dest, ".harness"), { recursive: true });
    cpSync(memory, join(dest, ".harness", "memory.json"));
  }
  const skills = join(repoRoot, ".harness", "skills");
  if (existsSync(skills)) {
    mkdirSync(join(dest, ".harness"), { recursive: true });
    cpSync(skills, join(dest, ".harness", "skills"), { recursive: true });
  }
}

/**
 * Give the copy a clean git baseline so the controller can report changed
 * paths. Best effort: a fixture that cannot be committed still runs.
 */
function initBaseline(workspace: string): void {
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: workspace, stdio: "ignore", timeout: 20_000 });
  try {
    git(["init", "-q"]);
    git(["-c", "user.email=eval@local", "-c", "user.name=eval", "add", "-A"]);
    git(["-c", "user.email=eval@local", "-c", "user.name=eval", "commit", "-qm", "fixture baseline"]);
  } catch {
    // Non-git or uncommittable fixture: changed paths will be empty.
  }
}

function resolveLimits(scenario: Scenario, defaults: TaskLimits): TaskLimits {
  return {
    maxToolCalls: scenario.limits.maxToolCalls ?? defaults.maxToolCalls,
    maxTaskMinutes: scenario.limits.maxTaskMinutes ?? defaults.maxTaskMinutes,
    maxRepairCycles: scenario.limits.maxRepairCycles ?? defaults.maxRepairCycles,
  };
}

/**
 * Run one scenario. Always writes a manifest (a crashed run is evidence too)
 * and returns it; only a broken scenario definition throws.
 */
export async function runScenario(opts: {
  repoRoot: string;
  scenario: Scenario;
  model: string;
  runner: ScenarioRunner;
  defaults: TaskLimits;
  now?: () => number;
}): Promise<ScenarioRun> {
  const { repoRoot, scenario, runner, model } = opts;
  if (!existsSync(scenario.fixtureDir)) {
    throw new EvalError(`fixture directory not found: ${scenario.fixtureDir}`);
  }
  const now = opts.now ?? Date.now;
  const startedAt = new Date(now()).toISOString();
  const runDir = join(
    evalsDir(repoRoot),
    `${scenario.name}-${now().toString(36)}`,
  );
  const workspace = join(runDir, "work");
  mkdirSync(workspace, { recursive: true });

  copyFixture(scenario.fixtureDir, workspace);
  copyContext(repoRoot, workspace);
  initBaseline(workspace);

  const limits = resolveLimits(scenario, opts.defaults);
  const contextSkills = listSkills(workspace).map((s) => s.name);
  const startMs = now();

  const manifest: ScenarioManifest = {
    schemaVersion: SCENARIO_MANIFEST_VERSION,
    kind: "scenario",
    scenario: scenario.name,
    at: startedAt,
    fixture: scenario.fixture,
    workspace: relative(repoRoot, workspace),
    model,
    phase: "error",
    passed: false,
    taskId: "",
    budgets: { toolCallsUsed: 0, secondsUsed: 0, repairCyclesUsed: 0 },
    durationMs: 0,
    checks: scenario.checks.map((c) => ({
      id: c.id,
      description: c.description,
      ...(c.command ? { command: c.command } : {}),
    })),
    contextSkills,
    validationResults: [],
  };

  try {
    const result = await runner({
      workspace,
      goal: scenario.goal,
      checks: scenario.checks,
      limits,
      model,
    });
    manifest.phase = result.record.phase;
    manifest.passed = result.record.phase === "completed";
    manifest.taskId = result.record.id;
    manifest.budgets = result.record.budgets;
    manifest.validationResults = result.record.validationResults;
    if (result.record.outcome) manifest.outcome = result.record.outcome;
  } catch (e) {
    manifest.outcome = `runner error: ${(e as Error).message}`;
  } finally {
    manifest.durationMs = now() - startMs;
    atomicWriteJson(join(runDir, "manifest.json"), manifest);
  }

  return { manifest, runDir };
}

/** Scenario names available as run evidence, newest last. */
export function listRunDirs(repoRoot: string): string[] {
  const dir = evalsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
