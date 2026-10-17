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

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
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
export function ensureAgentDir(dir: string = defaultAgentDir(), seedFrom?: string): AgentDirInfo {
  mkdirSync(dir, { recursive: true });
  const modelsPath = join(dir, "models.json");
  if (existsSync(modelsPath)) return { dir, modelsPath, seeded: false };

  const source = seedFrom ?? join(piAgentDir(), "models.json");
  if (!existsSync(source)) {
    throw new Error(
      `No model catalog at ${modelsPath} and nothing to seed from at ${source}. ` +
        `Create ${modelsPath} (Pi models.json format) or install pi with a configured provider.`,
    );
  }
  copyFileSync(source, modelsPath);
  return { dir, modelsPath, seeded: true };
}
