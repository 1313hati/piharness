/**
 * Task lifecycle types for the piharness task controller.
 *
 * Lifecycle:
 *   pending → inspecting → implementing → verifying → completed
 * Terminal alternatives: blocked, failed, cancelled
 * Verification may return to implementing within the repair budget.
 */

export const TASK_SCHEMA_VERSION = 1;

export type TaskPhase =
  | "pending"
  | "inspecting"
  | "implementing"
  | "verifying"
  | "completed"
  | "blocked"
  | "failed"
  | "cancelled";

/** Non-terminal phases (a task in one of these may be resumed). */
export const ACTIVE_PHASES: readonly TaskPhase[] = [
  "pending",
  "inspecting",
  "implementing",
  "verifying",
];

export function isTerminalPhase(phase: TaskPhase): boolean {
  return !ACTIVE_PHASES.includes(phase);
}

/** An acceptance check the task must satisfy. */
export interface TaskCheck {
  id: string;
  /** Human-readable description of what must be true. */
  description: string;
  /** Optional command to run to verify this check. */
  command?: string;
}

export interface TaskLimits {
  maxToolCalls: number;
  maxTaskMinutes: number;
  maxRepairCycles: number;
}

export interface TaskBudgets {
  toolCallsUsed: number;
  /** Wall-clock seconds consumed across all runs (resumable). */
  secondsUsed: number;
  /** Verification-driven repair cycles consumed. */
  repairCyclesUsed: number;
}

export interface TaskRecord {
  schemaVersion: number;
  id: string;
  goal: string;
  checks: TaskCheck[];
  phase: TaskPhase;
  /** Canonical workspace path. */
  workspace: string;
  /** Git HEAD at task start, if the workspace is a git repo. */
  startHead: string | null;
  /** Paths already dirty at task start — never assume a clean tree. */
  baselineDirtyPaths: string[];
  /** Pi session reference (Pi owns the transcript; we store the ref). */
  piSessionId: string | null;
  piSessionFile: string | null;
  model: string;
  limits: TaskLimits;
  budgets: TaskBudgets;
  createdAt: string;
  updatedAt: string;
  /** Validation results accumulated across runs. */
  validationResults: string[];
  /** Paths changed during the task (best effort). */
  changedPaths: string[];
  /** Final outcome detail (error message, blocker reason, ...). */
  outcome?: string;
  /** Next action if the task is unfinished. */
  nextAction?: string;
}

export function newTaskRecord(
  id: string,
  goal: string,
  checks: TaskCheck[],
  workspace: string,
  limits: TaskLimits,
  startHead: string | null,
  baselineDirtyPaths: string[],
): TaskRecord {
  const now = new Date().toISOString();
  return {
    schemaVersion: TASK_SCHEMA_VERSION,
    id,
    goal,
    checks,
    phase: "pending",
    workspace,
    startHead,
    baselineDirtyPaths,
    piSessionId: null,
    piSessionFile: null,
    model: "",
    limits,
    budgets: { toolCallsUsed: 0, secondsUsed: 0, repairCyclesUsed: 0 },
    createdAt: now,
    updatedAt: now,
    validationResults: [],
    changedPaths: [],
  };
}
