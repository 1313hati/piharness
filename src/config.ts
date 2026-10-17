/**
 * Configuration for the piharness application.
 *
 * Precedence: CLI args → project settings (.harness/config.json) → user settings → defaults.
 * Secrets stay in environment variables; never stored in config files.
 */

import { readFileSync, existsSync } from "node:fs";

export interface HarnessConfig {
  /** Model provider id (e.g. "local", "anthropic") */
  provider: string;
  /** Model id within the provider (e.g. "qwen38") */
  model: string;
  /** Working directory for the agent session */
  cwd: string;
  /** Max tool calls per task */
  maxToolCalls: number;
  /** Max wall-clock time per task in minutes */
  maxTaskMinutes: number;
  /** Default command timeout in seconds */
  commandTimeoutSec: number;
  /** Max verification-driven repair cycles after initial implementation */
  maxRepairCycles: number;
  /** Thinking level for the model */
  thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export const DEFAULTS: HarnessConfig = {
  provider: "local",
  model: "qwen38",
  cwd: process.cwd(),
  maxToolCalls: 40,
  maxTaskMinutes: 20,
  commandTimeoutSec: 120,
  maxRepairCycles: 2,
  // Reasoning on by default: the local model is a thinking model, and turning
  // it off measurably hurts multi-file edits. Override per repo in
  // .harness/config.json ("thinkingLevel": "off") or live with /think.
  thinkingLevel: "medium",
};

/**
 * Validate a project config against its declared ranges.
 * Throws with a descriptive message on the first violation.
 */
export function validateProjectConfig(cfg: ProjectConfig): void {
  const checks: Array<[string, number | undefined, (v: number) => boolean, string]> = [
    ["maxToolCalls", cfg.maxToolCalls, (v) => v > 0, "a positive number"],
    ["maxTaskMinutes", cfg.maxTaskMinutes, (v) => v > 0, "a positive number"],
    ["commandTimeoutSec", cfg.commandTimeoutSec, (v) => v > 0, "a positive number"],
    ["maxRepairCycles", cfg.maxRepairCycles, (v) => Number.isInteger(v) && v >= 0, "a non-negative integer"],
  ];
  for (const [key, value, ok, expected] of checks) {
    if (value !== undefined && (typeof value !== "number" || !ok(value))) {
      throw new Error(`Invalid .harness/config.json: ${key} must be ${expected}, got ${JSON.stringify(value)}`);
    }
  }
  if (cfg.thinkingLevel !== undefined && !isThinkingLevel(cfg.thinkingLevel)) {
    throw new Error(`Invalid .harness/config.json: thinkingLevel must be one of off|minimal|low|medium|high|xhigh|max, got ${JSON.stringify(cfg.thinkingLevel)}`);
  }
}

const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isThinkingLevel(v: unknown): v is HarnessConfig["thinkingLevel"] {
  return typeof v === "string" && (THINKING_LEVELS as readonly string[]).includes(v);
}

export interface ProjectConfig {
  provider?: string;
  model?: string;
  maxToolCalls?: number;
  maxTaskMinutes?: number;
  commandTimeoutSec?: number;
  maxRepairCycles?: number;
  thinkingLevel?: HarnessConfig["thinkingLevel"];
}

/**
 * Load and merge configuration.
 * @param cliOverrides - values from CLI arguments (highest priority)
 * @param projectDir - project root for .harness/config.json
 */
export function loadConfig(
  cliOverrides: Partial<HarnessConfig> = {},
  projectDir: string = process.cwd(),
): HarnessConfig {
  // Load project config. Missing file → defaults; present but invalid →
  // fail loudly so a typo'd config is never silently ignored.
  let projectCfg: ProjectConfig = {};
  const projectCfgPath = `${projectDir}/.harness/config.json`;
  if (existsSync(projectCfgPath)) {
    const raw = readFileSync(projectCfgPath, "utf-8");
    projectCfg = JSON.parse(raw);
  }
  validateProjectConfig(projectCfg);

  // Merge: defaults ← project ← CLI.
  // Spread only defined CLI values — a Partial<HarnessConfig> may carry
  // explicit undefineds (e.g. from absent CLI flags) which would otherwise
  // clobber the defaults during the spread.
  const cli: Partial<HarnessConfig> = {};
  for (const [k, v] of Object.entries(cliOverrides)) {
    if (v !== undefined) (cli as Record<string, unknown>)[k] = v;
  }

  const merged: HarnessConfig = {
    ...DEFAULTS,
    ...projectCfg,
    cwd: projectDir,
    ...cli,
    // cwd always comes from CLI or projectDir, never from project config
  };

  return merged;
}
