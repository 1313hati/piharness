/**
 * The harness's own Pi agent directory.
 *
 * The user already runs `pi` on this machine, with its own config, sessions
 * and (possibly) credentials in ~/.pi/agent. The harness must not write there:
 * sharing that directory would let two different front-ends overwrite each
 * other's session files and settings.
 *
 * So piharness keeps a sibling directory, seeded once with a *copy* of the
 * model catalog (models.json). Session files, settings and any auth state the
 * harness produces stay here. ~/.pi/agent is only ever read, and only for that
 * first copy.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Where the user's existing `pi` install keeps its state. Read-only for us. */
export function piAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/** Override with PIHARNESS_AGENT_DIR; default keeps state out of ~/.pi. */
export function defaultAgentDir(): string {
  const override = process.env.PIHARNESS_AGENT_DIR;
  return override && override.trim() ? override : join(homedir(), ".config", "piharness", "agent");
}

export interface AgentDirInfo {
  dir: string;
  modelsPath: string;
  /** True when models.json was copied out of the pi install on this call. */
  seeded: boolean;
}

/**
 * Ensure the harness agent directory exists with a usable model catalog.
 * Seeding is one-shot: once models.json exists it is never overwritten from
 * ~/.pi, so later edits by the user stick.
 */
/**
 * Output budget for a single model response.
 *
 * A `write` of a large file is one response: at the old 8192-token ceiling a
 * 500-line file was cut off mid-argument and Pi refused the call ("the
 * response hit the output token limit"). 16384 covers ordinary files; bigger
 * ones should be written in chunks, which the preamble asks for.
 */
export function outputBudget(): number {
  const env = Number(process.env.PIHARNESS_MAX_OUTPUT);
  return Number.isFinite(env) && env >= 1024 ? Math.floor(env) : 16384;
}

/**
 * Raise `maxTokens` for local models in the harness catalog. Idempotent, and
 * only ever lowers nothing: a larger user-set value is left alone.
 */
export function applyOutputBudget(modelsPath: string, budget = outputBudget()): boolean {
  let catalog: any;
  try {
    catalog = JSON.parse(readFileSync(modelsPath, "utf8"));
  } catch {
    return false;
  }
  const providers = catalog?.providers;
  if (!providers || typeof providers !== "object") return false;
  let changed = false;
  for (const provider of Object.values<any>(providers)) {
    const baseUrl = typeof provider?.baseUrl === "string" ? provider.baseUrl : "";
    const isLocal = /(127\.0\.0\.1|localhost|0\.0\.0\.0)/.test(baseUrl) || provider?.apiKey === "local";
    if (!isLocal || !Array.isArray(provider?.models)) continue;
    for (const model of provider.models) {
      const current = typeof model?.maxTokens === "number" ? model.maxTokens : 0;
      if (current < budget) {
        model.maxTokens = budget;
        changed = true;
      }
    }
  }
  if (changed) writeFileSync(modelsPath, `${JSON.stringify(catalog, null, 2)}\n`);
  return changed;
}

export function ensureAgentDir(dir: string = defaultAgentDir(), seedFrom?: string): AgentDirInfo {
  mkdirSync(dir, { recursive: true });
  const modelsPath = join(dir, "models.json");
  if (existsSync(modelsPath)) {
    applyOutputBudget(modelsPath);
    return { dir, modelsPath, seeded: false };
  }

  const source = seedFrom ?? join(piAgentDir(), "models.json");
  if (!existsSync(source)) {
    throw new Error(
      `No model catalog at ${modelsPath} and nothing to seed from at ${source}. ` +
        `Create ${modelsPath} (Pi models.json format) or install pi with a configured provider.`,
    );
  }
  copyFileSync(source, modelsPath);
  applyOutputBudget(modelsPath);
  return { dir, modelsPath, seeded: true };
}
