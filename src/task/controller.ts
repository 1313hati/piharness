/**
 * Task controller: lifecycle, budgets, bounded repair, resume.
 *
 * The controller sets task context and limits, observes execution, and
 * requests a bounded follow-up only when validation requires one.
 * It does NOT run a second agent loop around Pi's internal loop.
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  newTaskRecord,
  isTerminalPhase,
  type TaskCheck,
  type TaskLimits,
  type TaskPhase,
  type TaskRecord,
} from "./types.js";
import {
  acquireLock,
  findActiveTask,
  loadTask,
  saveTask,
  type LockHandle,
} from "./store.js";
import type { HarnessSession, NormalizedEvent } from "../pi/session.js";

// ─── Git helpers ───────────────────────────────────────────────────────────────

function git(workspace: string, args: string[]): string | null {
  try {
    return execSync(`git ${args.join(" ")}`, {
      cwd: workspace,
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return null;
  }
}

export function gitHead(workspace: string): string | null {
  return git(workspace, ["rev-parse", "HEAD"]);
}

/** Current dirty paths (modified, staged, untracked). */
export function dirtyPaths(workspace: string): string[] {
  const out = git(workspace, ["status", "--porcelain"]);
  if (out === null) return [];
  return out
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => l.slice(3).trim());
}

// ─── Workspace reconciliation ──────────────────────────────────────────────────

export interface Reconciliation {
  /** True if the workspace looks like the same one the task started in. */
  sameHead: boolean;
  /** New dirty paths since task start. */
  newDirtyPaths: string[];
  /** Baseline paths that are no longer dirty (user may have committed/reverted). */
  resolvedBaselinePaths: string[];
  notes: string[];
}

/**
 * Re-inspect the workspace before resuming. Never replay a possibly
 * completed shell command automatically; ambiguous operations are reported
 * as requiring inspection.
 */
export function reconcileWorkspace(record: TaskRecord): Reconciliation {
  const notes: string[] = [];
  const head = gitHead(record.workspace);
  const sameHead = record.startHead === null ? true : head === record.startHead;
  if (!sameHead) {
    notes.push(
      `Git HEAD changed since task start (${record.startHead} → ${head ?? "no HEAD"}). ` +
      `The branch or working tree changed; reconcile before continuing.`,
    );
  }
  const current = new Set(dirtyPaths(record.workspace));
  const baseline = new Set(record.baselineDirtyPaths);
  const newDirtyPaths = [...current].filter((p) => !baseline.has(p));
  const resolvedBaselinePaths = [...baseline].filter((p) => !current.has(p));
  if (resolvedBaselinePaths.length > 0) {
    notes.push(
      `Baseline-dirty paths no longer dirty (committed or reverted?): ${resolvedBaselinePaths.join(", ")}`,
    );
  }
  return { sameHead, newDirtyPaths, resolvedBaselinePaths, notes };
}

// ─── Budgets ───────────────────────────────────────────────────────────────────

export interface BudgetStatus {
  ok: boolean;
  reason?: string;
}

export function checkBudgets(record: TaskRecord): BudgetStatus {
  if (record.budgets.toolCallsUsed >= record.limits.maxToolCalls) {
    return {
      ok: false,
      reason: `Tool call budget exhausted (${record.budgets.toolCallsUsed}/${record.limits.maxToolCalls})`,
    };
  }
  if (record.budgets.secondsUsed >= record.limits.maxTaskMinutes * 60) {
    return {
      ok: false,
      reason: `Time budget exhausted (${Math.floor(record.budgets.secondsUsed / 60)}m/${record.limits.maxTaskMinutes}m)`,
    };
  }
  return { ok: true };
}

// ─── Controller ────────────────────────────────────────────────────────────────

export interface RunTaskOptions {
  workspace: string;
  goal: string;
  checks: TaskCheck[];
  limits: TaskLimits;
  model: string;
  /** Resume an existing task id instead of creating a new one. */
  resumeId?: string;
  /** Create and drive the session for a given prompt. */
  createSession: (prompt: string) => Promise<HarnessSession>;
  /** Observe one run to completion; returns session stats. */
  runPrompt: (session: HarnessSession, prompt: string) => Promise<{ toolCalls: number }>;
  /** Dispose a session. */
  disposeSession: (session: HarnessSession) => void;
  /** Emit a normalized event (streaming). */
  onEvent?: (event: NormalizedEvent) => void;
  /** Run a check command; returns { ok, output }. */
  runCheck?: (check: TaskCheck) => Promise<{ ok: boolean; output: string }>;
}

export interface RunResult {
  record: TaskRecord;
  /** True if the task reached a terminal phase during this run. */
  terminal: boolean;
}

/**
 * Create a new task record (pending) and persist it.
 */
export function createTaskRecord(opts: {
  id: string;
  goal: string;
  checks: TaskCheck[];
  workspace: string;
  limits: TaskLimits;
  model: string;
}): TaskRecord {
  const head = gitHead(opts.workspace);
  const baseline = dirtyPaths(opts.workspace);
  const record = newTaskRecord(
    opts.id,
    opts.goal,
    opts.checks,
    opts.workspace,
    opts.limits,
    head,
    baseline,
  );
  record.model = opts.model;
  return record;
}

/**
 * Run a task to a terminal phase (or until the caller cancels).
 *
 * Flow:
 *   1. Acquire workspace lock.
 *   2. Create or load the task record.
 *   3. If resuming: reconcile workspace; if it changed materially, mark
 *      blocked with a note instead of continuing blindly.
 *   4. Prompt the session with the goal (or a repair prompt).
 *   5. After the run settles: record budgets, run checks.
 *   6. If checks fail and repair budget remains: one bounded repair
 *      follow-up, then re-check. Repeated identical failures without new
 *      evidence stop the loop.
 *   7. Persist final state; release lock.
 */
export async function runTask(opts: RunTaskOptions): Promise<RunResult> {
  const lock = acquireLock(opts.workspace, opts.resumeId ?? "pending");
  let session: HarnessSession | null = null;
  try {
    let record: TaskRecord;
    if (opts.resumeId) {
      record = loadTask(opts.workspace, opts.resumeId);
      if (isTerminalPhase(record.phase)) {
        throw new Error(`Task ${record.id} is already terminal (${record.phase}); nothing to resume.`);
      }
      const recon = reconcileWorkspace(record);
      if (!recon.sameHead) {
        record.phase = "blocked";
        record.outcome = "Workspace changed since task start; manual reconciliation required.";
        record.nextAction = recon.notes.join(" ");
        saveTask(opts.workspace, record);
        return { record, terminal: true };
      }
      record.phase = "implementing";
      saveTask(opts.workspace, record);
    } else {
      const id = `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      record = createTaskRecord({
        id,
        goal: opts.goal,
        checks: opts.checks,
        workspace: opts.workspace,
        limits: opts.limits,
        model: opts.model,
      });
      record.phase = "implementing";
      saveTask(opts.workspace, record);
    }

    // ── Implementation run ──
    const startWall = Date.now();
    session = await opts.createSession(buildPrompt(record));
    record.piSessionId = session.sessionId;
    record.piSessionFile = session.sessionFile ?? null;
    saveTask(opts.workspace, record);

    const stats = await opts.runPrompt(session, buildPrompt(record));
    record.budgets.toolCallsUsed += stats.toolCalls;
    record.budgets.secondsUsed += Math.round((Date.now() - startWall) / 1000);
    record.phase = "verifying";
    saveTask(opts.workspace, record);

    // ── Verification + bounded repair ──
    let lastFailureSignature = "";
    while (true) {
      const results = await runChecks(opts, record);
      record.validationResults.push(...results.map((r) => r.line));
      const failed = results.filter((r) => !r.ok);
      saveTask(opts.workspace, record);

      if (failed.length === 0) {
        record.phase = "completed";
        record.outcome = "All acceptance checks passed.";
        record.nextAction = undefined;
        break;
      }

      // Include the tail of the output so a check that fails with *new*
      // evidence is not mistaken for a repeated identical failure.
      const signature = failed
        .map((f) => `${f.line}::${f.output.slice(-500)}`)
        .join("\n");
      if (signature === lastFailureSignature) {
        // Repeated identical failures without new evidence: stop.
        record.phase = "failed";
        record.outcome = `Checks failed and repair produced no new evidence: ${signature}`;
        record.nextAction = "Inspect the failures manually; the bounded repair loop stopped.";
        break;
      }
      lastFailureSignature = signature;

      if (record.budgets.repairCyclesUsed >= record.limits.maxRepairCycles) {
        record.phase = "failed";
        record.outcome = `Checks failed after ${record.budgets.repairCyclesUsed} repair cycles: ${signature}`;
        record.nextAction = "Repair budget exhausted; inspect manually.";
        break;
      }

      const budget = checkBudgets(record);
      if (!budget.ok) {
        record.phase = "blocked";
        record.outcome = budget.reason;
        record.nextAction = "Budget exhausted; continue with an explicit continuation if needed.";
        break;
      }

      // Bounded repair follow-up.
      record.budgets.repairCyclesUsed += 1;
      record.phase = "implementing";
      saveTask(opts.workspace, record);

      const repairStart = Date.now();
      const repairStats = await opts.runPrompt(session, buildRepairPrompt(record, failed));
      record.budgets.toolCallsUsed += repairStats.toolCalls;
      record.budgets.secondsUsed += Math.round((Date.now() - repairStart) / 1000);
      record.phase = "verifying";
      saveTask(opts.workspace, record);
    }

    record.changedPaths = dirtyPaths(opts.workspace).filter(
      (p) => !record.baselineDirtyPaths.includes(p),
    );
    saveTask(opts.workspace, record);
    return { record, terminal: isTerminalPhase(record.phase) };
  } finally {
    if (session) opts.disposeSession(session);
    lock.release();
  }
}

// ─── Prompt building ───────────────────────────────────────────────────────────

function buildPrompt(record: TaskRecord): string {
  const checks = record.checks
    .map((c) => `- ${c.description}${c.command ? ` (verify: ${c.command})` : ""}`)
    .join("\n");
  return [
    `Task: ${record.goal}`,
    "",
    "Acceptance checks:",
    checks || "- (none specified)",
    "",
    "Work in the current directory. Make a focused change, inspect the diff, and run the relevant checks. Do not send complete repositories or endless command output into context.",
  ].join("\n");
}

function buildRepairPrompt(record: TaskRecord, failed: CheckResult[]): string {
  const failures = failed.map((f) => `- ${f.line}\n${f.output.slice(-2000)}`).join("\n");
  return [
    `The previous attempt did not pass all acceptance checks.`,
    ``,
    `Failures:`,
    failures,
    ``,
    `Goal: ${record.goal}`,
    ``,
    `Repair only what the evidence indicates. Then re-run the relevant checks.`,
  ].join("\n");
}

// ─── Checks ────────────────────────────────────────────────────────────────────

export interface CheckResult {
  ok: boolean;
  line: string;
  output: string;
}

async function runChecks(opts: RunTaskOptions, record: TaskRecord): Promise<CheckResult[]> {
  if (record.checks.length === 0) {
    return [];
  }
  const results: CheckResult[] = [];
  for (const check of record.checks) {
    if (check.command && opts.runCheck) {
      const r = await opts.runCheck(check);
      results.push({
        ok: r.ok,
        line: `${check.id}: ${check.description} — ${r.ok ? "PASS" : "FAIL"}`,
        output: r.output,
      });
    } else {
      // No command: the check is judged by the model's final report.
      // We cannot verify it deterministically — mark as unverified, not failed.
      results.push({
        ok: true,
        line: `${check.id}: ${check.description} — UNVERIFIED (no command)`,
        output: "",
      });
    }
  }
  return results;
}

// ─── Status ────────────────────────────────────────────────────────────────────

export function formatStatus(record: TaskRecord): string {
  const lines = [
    `Task: ${record.id}`,
    `Goal: ${record.goal}`,
    `Phase: ${record.phase}`,
    `Workspace: ${record.workspace}`,
    `Model: ${record.model}`,
    `Pi session: ${record.piSessionId ?? "(none)"}`,
    `Budgets: tool calls ${record.budgets.toolCallsUsed}/${record.limits.maxToolCalls}, ` +
      `time ${Math.floor(record.budgets.secondsUsed / 60)}m/${record.limits.maxTaskMinutes}m, ` +
      `repairs ${record.budgets.repairCyclesUsed}/${record.limits.maxRepairCycles}`,
  ];
  if (record.validationResults.length > 0) {
    lines.push(`Last checks:`);
    for (const line of record.validationResults.slice(-5)) {
      lines.push(`  ${line}`);
    }
  }
  if (record.outcome) lines.push(`Outcome: ${record.outcome}`);
  if (record.nextAction) lines.push(`Next: ${record.nextAction}`);
  return lines.join("\n");
}
