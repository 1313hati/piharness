/**
 * Session evidence — what a finished working session actually did.
 *
 * This is the raw material for learning. It is derived from the transcript the
 * TUI already renders, so nothing extra is asked of the model and nothing has
 * to be trusted that a tool did not do. Evidence is written to
 * `.harness/state/sessions/<id>.json` and stays inspectable.
 *
 * Deliberately Pi-free: blocks in, record out.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptBlock } from "../ui/blocks.js";
import { atomicWriteJson } from "../fsutil.js";

export const EVIDENCE_SCHEMA_VERSION = 1;
const MAX_GOALS = 10;
const MAX_TOOLS = 200;

export interface ToolTrace {
  name: string;
  /** The call's one-line summary (path, command, query). */
  detail: string;
  status: "ok" | "error" | "running";
}

export interface SessionEvidence {
  schemaVersion: number;
  id: string;
  at: string;
  cwd: string;
  /** User prompts, oldest first (slash commands excluded). */
  goals: string[];
  tools: ToolTrace[];
  /** Files the session edited and the tool reported success for. */
  changedPaths: string[];
  /** Canonical verify commands that succeeded, in order. */
  verifyCommands: string[];
  /** Verify commands that failed (kept for the audit trail only). */
  failedVerify: string[];
  toolCalls: number;
  errors: number;
}

/** Tools whose `detail` is a path they modified. */
const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "create",
  "patch",
  "apply_patch",
  "multiedit",
  "str_replace",
  "write_file",
  "edit_file",
]);

/**
 * Canonical forms of project gates we are willing to run again later.
 * Matching returns the canonical string, never the model's raw command line:
 * a proposal must not be able to smuggle `rm -rf` into an evaluation.
 */
const VERIFY_PATTERNS: Array<[RegExp, string]> = [
  [/\bnpm\s+(?:run\s+)?(test|build|typecheck|check|lint)\b/, "npm-self"],
  [/\bnpx\s+tsc\s+--noEmit\b/, "npx tsc --noEmit"],
  [/\btsc\s+--noEmit\b/, "npx tsc --noEmit"],
  [/\bnode\s+--test\b/, "npm test"],
  [/\b(?:python3?\s+-m\s+)?pytest\b/, "pytest"],
  [/\b(?:python3?\s+-m\s+)?unittest\b/, "python -m unittest"],
  [/\bcargo\s+test\b/, "cargo test"],
  [/\bcargo\s+check\b/, "cargo check"],
  [/\bcargo\s+clippy\b/, "cargo clippy"],
  [/\bgo\s+test\b/, "go test ./..."],
  [/\bmake\s+test\b/, "make test"],
  [/\bbun\s+test\b/, "bun test"],
  [/\bdeno\s+(test|check)\b/, "deno $1"],
  [/\bruff\s+check\b/, "ruff check"],
  [/\bpyright\b/, "pyright"],
];

/** Canonical verify command contained in a shell line, or null. */
export function verifyCommandFrom(detail: string): string | null {
  for (const [re, canonical] of VERIFY_PATTERNS) {
    const m = re.exec(detail);
    if (m) {
      if (canonical === "npm-self") {
        const script = m[1];
        return script === "test" ? "npm test" : `npm run ${script}`;
      }
      return canonical.replace("$1", m[1] ?? "");
    }
  }
  return null;
}

const PATH_RE = /\.(?:[cm]?[jt]sx?|py|rs|go|rb|java|kt|c|h|cc|cpp|hpp|cs|php|swift|scala|sh|sql|lua|md|json|ya?ml|toml|css|html)$/i;

/** The path a mutating tool touched, if the detail looks like one. */
export function changedPathFrom(tool: string, detail: string, status: ToolTrace["status"]): string | null {
  if (status !== "ok") return null;
  if (!EDIT_TOOLS.has(tool.toLowerCase())) return null;
  const candidate = detail.split(/\s+/)[0] ?? "";
  return PATH_RE.test(candidate) ? candidate : null;
}

/**
 * Build evidence from a finished transcript. Returns null when the session
 * never called a tool — a chat-only session has nothing to teach.
 */
export function deriveEvidence(
  blocks: TranscriptBlock[],
  opts: { cwd: string; id?: string; at?: string },
): SessionEvidence | null {
  const tools: ToolTrace[] = [];
  const goals: string[] = [];
  const changed = new Set<string>();
  const verify: string[] = [];
  const failed: string[] = [];
  let errors = 0;

  for (const block of blocks) {
    if (block.kind === "user") {
      const text = block.text.trim();
      if (text && !text.startsWith("/") && goals.length < MAX_GOALS) goals.push(text);
      continue;
    }
    if (block.kind !== "tool") continue;
    const trace: ToolTrace = { name: block.name, detail: block.detail, status: block.status };
    if (tools.length < MAX_TOOLS) tools.push(trace);
    if (block.status === "error") errors++;

    const path = changedPathFrom(block.name, block.detail, block.status);
    if (path) changed.add(path);

    const cmd = verifyCommandFrom(block.detail);
    if (cmd) {
      if (block.status === "ok") verify.push(cmd);
      else if (block.status === "error") failed.push(cmd);
    }
  }

  if (tools.length === 0) return null;

  return {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    id: opts.id ?? randomUUID(),
    at: opts.at ?? new Date().toISOString(),
    cwd: opts.cwd,
    goals,
    tools,
    changedPaths: [...changed],
    verifyCommands: dedupe(verify),
    failedVerify: dedupe(failed).filter((c) => !verify.includes(c)),
    toolCalls: tools.length,
    errors,
  };
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

// ─── storage ────────────────────────────────────────────────────────────────

export function sessionsRoot(workspace: string): string {
  return join(workspace, ".harness", "state", "sessions");
}

export function evidenceFile(workspace: string, id: string): string {
  return join(sessionsRoot(workspace), `${id}.json`);
}

export function saveEvidence(workspace: string, evidence: SessionEvidence): string {
  const file = evidenceFile(workspace, evidence.id);
  mkdirSync(sessionsRoot(workspace), { recursive: true });
  atomicWriteJson(file, evidence);
  return file;
}

export function loadEvidence(workspace: string, id: string): SessionEvidence | null {
  const file = evidenceFile(workspace, id);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SessionEvidence;
    if (raw.schemaVersion !== EVIDENCE_SCHEMA_VERSION) return null;
    if (typeof raw.id !== "string" || !Array.isArray(raw.tools)) return null;
    return raw;
  } catch {
    return null;
  }
}

/** All stored sessions, oldest first. Corrupt files are skipped. */
export function listEvidence(workspace: string): SessionEvidence[] {
  const root = sessionsRoot(workspace);
  if (!existsSync(root)) return [];
  const out: SessionEvidence[] = [];
  for (const entry of readdirSync(root)) {
    if (!entry.endsWith(".json")) continue;
    const e = loadEvidence(workspace, entry.slice(0, -5));
    if (e) out.push(e);
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
