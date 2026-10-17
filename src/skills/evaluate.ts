/**
 * Proposal evaluation — run a proposal's verify commands in the workspace
 * and record an immutable manifest under .harness/state/evals/.
 *
 * Promotion (approve) requires a passed evaluation. This is the
 * "evaluation → promotion" gate from docs/architecture.md.
 */

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { atomicWriteJson } from "../fsutil.js";
import { loadProposal, saveProposal } from "./proposals.js";
import { SkillError } from "./types.js";
import type { EvalManifest, EvalCommandResult } from "./types.js";

export const COMMAND_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 500;

export function evalsRoot(workspace: string): string {
  return join(workspace, ".harness", "state", "evals");
}

function runCommand(
  workspace: string,
  command: string,
): { ok: boolean; exitCode: number; outputTail: string } {
  try {
    const out = execFileSync("/bin/sh", ["-c", command], {
      cwd: workspace,
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 1024 * 1024,
      encoding: "utf8",
    });
    return { ok: true, exitCode: 0, outputTail: out.slice(-OUTPUT_TAIL_CHARS) };
  } catch (err) {
    const e = err as { status?: number | null; stdout?: string; stderr?: string };
    const output = `${e.stdout ?? ""}${e.stderr ?? ""}${e.stdout == null && e.stderr == null ? String(err) : ""}`;
    return {
      ok: false,
      exitCode: typeof e.status === "number" ? e.status : 1,
      outputTail: output.slice(-OUTPUT_TAIL_CHARS),
    };
  }
}

/**
 * Evaluate a proposal: run each verify command in order (stop at first
 * failure), write a manifest, and stamp the proposal with the result.
 */
export function evaluateProposal(
  workspace: string,
  name: string,
): { manifest: EvalManifest; passed: boolean } {
  const p = loadProposal(workspace, name);
  if (!p) throw new SkillError(`no proposal named "${name}"`);

  const commands: EvalCommandResult[] = [];
  let passed = false;
  for (const command of p.verifyCommands) {
    const r = runCommand(workspace, command);
    commands.push({ command, ok: r.ok, exitCode: r.exitCode, outputTail: r.outputTail });
    if (!r.ok) break;
  }
  passed = p.verifyCommands.length > 0 && commands.every((c) => c.ok);

  const at = new Date().toISOString();
  const manifest: EvalManifest = {
    schemaVersion: 1,
    proposal: name,
    at,
    commands,
    passed,
  };
  const manifestFile = join(evalsRoot(workspace), `${name}-${Date.now().toString(36)}.json`);
  atomicWriteJson(manifestFile, manifest);

  const last = commands[commands.length - 1];
  p.evalResult = {
    passed,
    exitCode: last ? last.exitCode : -1,
    command: last ? last.command : "",
    outputTail: last ? last.outputTail : "no verify commands recorded",
    at,
  };
  p.updatedAt = at;
  saveProposal(workspace, p);
  return { manifest, passed };
}
