/**
 * Evaluation scenarios (M5) — repeatable tasks kept under `evals/scenarios/`.
 *
 * A scenario pins a fixture repo, a goal, and the acceptance checks used to
 * judge it, so "does the harness get better?" can be measured instead of
 * asserted. Loading is pure: no fixture is copied and no task is run here.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { TaskCheck, TaskLimits } from "../task/types.js";

export const SCENARIO_SCHEMA_VERSION = 1;

export class EvalError extends Error {}

export interface Scenario {
  schemaVersion: number;
  /** Stable, filesystem-safe id used on the command line. */
  name: string;
  description: string;
  /** Absolute fixture directory (resolved when the scenario is loaded). */
  fixtureDir: string;
  /** Fixture path as written in the scenario file (for evidence). */
  fixture: string;
  goal: string;
  checks: TaskCheck[];
  /** Optional per-scenario overrides of the harness defaults. */
  limits: Partial<TaskLimits>;
  /** Absolute path of the scenario file. */
  path: string;
}

const NAME_RE = /^[\w-]{1,64}$/;

export function scenariosRoot(repoRoot: string): string {
  return join(repoRoot, "evals", "scenarios");
}

function asString(v: unknown, what: string, file: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new EvalError(`${file}: ${what} must be a non-empty string`);
  }
  return v.trim();
}

function parseLimits(raw: unknown, file: string): Partial<TaskLimits> {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null) {
    throw new EvalError(`${file}: limits must be an object`);
  }
  const src = raw as Record<string, unknown>;
  const out: Partial<TaskLimits> = {};
  for (const key of ["maxToolCalls", "maxTaskMinutes", "maxRepairCycles"] as const) {
    const v = src[key];
    if (v === undefined) continue;
    // maxRepairCycles: 0 is meaningful (no repair loop). Tool-call and
    // time budgets of 0 would make every run instantly blocked.
    const min = key === "maxRepairCycles" ? 0 : 1;
    if (typeof v !== "number" || !Number.isFinite(v) || v < min) {
      throw new EvalError(`${file}: limits.${key} must be a number >= ${min}`);
    }
    out[key] = v;
  }
  return out;
}

function parseChecks(raw: unknown, file: string): TaskCheck[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new EvalError(`${file}: checks must be a non-empty array`);
  }
  return raw.map((c, i) => {
    if (typeof c !== "object" || c === null) {
      throw new EvalError(`${file}: checks[${i}] must be an object`);
    }
    const src = c as Record<string, unknown>;
    const description = asString(src.description, `checks[${i}].description`, file);
    const check: TaskCheck = { id: `c${i + 1}`, description };
    if (src.command !== undefined) {
      check.command = asString(src.command, `checks[${i}].command`, file);
    }
    return check;
  });
}

/** Load and validate one scenario file. Throws EvalError on any defect. */
export function loadScenario(path: string): Scenario {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new EvalError(`${path}: not valid JSON (${(e as Error).message})`);
  }
  if (typeof raw !== "object" || raw === null) {
    throw new EvalError(`${path}: scenario must be a JSON object`);
  }
  const src = raw as Record<string, unknown>;
  if (src.schemaVersion !== SCENARIO_SCHEMA_VERSION) {
    throw new EvalError(
      `${path}: unsupported schemaVersion ${String(src.schemaVersion)} (expected ${SCENARIO_SCHEMA_VERSION})`,
    );
  }
  const name = asString(src.name, "name", path);
  if (!NAME_RE.test(name)) {
    throw new EvalError(`${path}: name "${name}" must be 1-64 word characters or dashes`);
  }
  const fixture = asString(src.fixture, "fixture", path);
  const fixtureDir = resolve(dirname(path), fixture);
  if (!existsSync(fixtureDir)) {
    throw new EvalError(`${path}: fixture directory not found: ${fixtureDir}`);
  }
  return {
    schemaVersion: SCENARIO_SCHEMA_VERSION,
    name,
    description: typeof src.description === "string" ? src.description.trim() : "",
    fixture,
    fixtureDir,
    goal: asString(src.goal, "goal", path),
    checks: parseChecks(src.checks, path),
    limits: parseLimits(src.limits, path),
    path,
  };
}

/** All scenarios under `<repo>/evals/scenarios/`, sorted by name. */
export function listScenarios(repoRoot: string): Scenario[] {
  const root = scenariosRoot(repoRoot);
  if (!existsSync(root)) return [];
  const out: Scenario[] = [];
  const files = readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".json"))
    .map((e) => join(root, e.name));
  for (const file of files) out.push(loadScenario(file));
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function findScenario(repoRoot: string, name: string): Scenario | null {
  return listScenarios(repoRoot).find((s) => s.name === name) ?? null;
}
