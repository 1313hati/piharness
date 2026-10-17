/**
 * Task state persistence: atomic writes, workspace lock with stale-lock recovery.
 *
 * Storage: <workspace>/.harness/state/tasks/<id>.json
 * One task writer per workspace, enforced by a lock file.
 */

import {
  readFileSync,
  mkdirSync,
  existsSync,
  unlinkSync,
  statSync,
  readdirSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { ACTIVE_PHASES, type TaskRecord } from "./types.js";
import { atomicWriteJson } from "../fsutil.js";

export { atomicWriteJson }; // re-exported for existing consumers

const STATE_DIR = ".harness/state";
const TASKS_DIR = "tasks";
const LOCK_NAME = "workspace.lock";
const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes

export class LockError extends Error {}
export class SchemaError extends Error {}

// ─── Paths ─────────────────────────────────────────────────────────────────────

export function stateDir(workspace: string): string {
  return join(workspace, STATE_DIR);
}

export function tasksDir(workspace: string): string {
  return join(stateDir(workspace), TASKS_DIR);
}

export function taskPath(workspace: string, id: string): string {
  return join(tasksDir(workspace), `${id}.json`);
}

function lockPath(workspace: string): string {
  return join(stateDir(workspace), LOCK_NAME);
}

// ─── Atomic write ──────────────────────────────────────────────────────────────

/**
 * Write JSON atomically: write to a temp file in the same directory, then
 * rename over the target. A crash mid-write never leaves a partial file.
 */


// ─── Task record I/O ───────────────────────────────────────────────────────────

/**
 * Save a task record atomically. Updates updatedAt unless pinned.
 */
export function saveTask(workspace: string, record: TaskRecord): void {
  record.updatedAt = new Date().toISOString();
  atomicWriteJson(taskPath(workspace, record.id), record);
}

/**
 * Load a task record. Throws SchemaError on unknown newer schema versions
 * (never overwrite what we don't understand) and on corrupt JSON.
 */
export function loadTask(workspace: string, id: string): TaskRecord {
  const p = taskPath(workspace, id);
  if (!existsSync(p)) {
    throw new Error(`Task not found: ${id} (looked in ${p})`);
  }
  let raw: string;
  try {
    raw = readFileSync(p, "utf-8");
  } catch (err) {
    throw new Error(`Failed to read task ${id}: ${err instanceof Error ? err.message : String(err)}`);
  }
  let record: TaskRecord;
  try {
    record = JSON.parse(raw) as TaskRecord;
  } catch {
    throw new SchemaError(`Task ${id} has corrupt JSON; refusing to overwrite. Inspect ${p} manually.`);
  }
  if (typeof record.schemaVersion !== "number" || record.schemaVersion > 1) {
    throw new SchemaError(
      `Task ${id} has schema version ${record.schemaVersion}; this harness only understands <= 1. Refusing to overwrite.`,
    );
  }
  return record;
}

/** List all task ids in a workspace. */
export function listTaskIds(workspace: string): string[] {
  const dir = tasksDir(workspace);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5));
}

/** Find the most recently updated non-terminal task, if any. */
export function findActiveTask(workspace: string): TaskRecord | null {
  const ids = listTaskIds(workspace);
  let best: TaskRecord | null = null;
  for (const id of ids) {
    let rec: TaskRecord;
    try {
      rec = loadTask(workspace, id);
    } catch {
      continue; // corrupt or unknown schema — skip
    }
    if (!ACTIVE_PHASES.includes(rec.phase)) continue;
    if (!best || rec.updatedAt > best.updatedAt) best = rec;
  }
  return best;
}

// ─── Workspace lock ────────────────────────────────────────────────────────────

export interface LockHandle {
  release(): void;
}

interface LockContent {
  pid: number;
  taskId: string;
  acquiredAt: string;
}

/**
 * Acquire the per-workspace lock.
 *
 * - If no lock exists: create it (atomic O_EXCL via temp+rename is not
 *   atomic across the check; we use a two-step: write unique temp, rename;
 *   a concurrent winner's rename would fail if we checked first — we check
 *   after rename and re-read to detect the race).
 * - If a lock exists and is fresh: throw LockError.
 * - If a lock exists but is stale (>30 min) or the holder pid is dead:
 *   recover by removing it and retrying once.
 */
export function acquireLock(workspace: string, taskId: string): LockHandle {
  const p = lockPath(workspace);
  mkdirSync(dirname(p), { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    if (existsSync(p)) {
      const existing = readLock(p);
      if (existing && !isStaleLock(existing)) {
        throw new LockError(
          `Workspace is locked by task ${existing.taskId} (pid ${existing.pid}, acquired ${existing.acquiredAt}). ` +
          `One task writer per workspace. If that process is dead, wait for the lock to go stale (30 min) or remove ${p} manually.`,
        );
      }
      // Stale or unreadable lock: recover.
      try {
        unlinkSync(p);
      } catch {
        // Another process may have removed it; fall through and retry.
      }
      if (attempt === 0) continue;
    }

    // Create the lock.
    const content: LockContent = { pid: process.pid, taskId, acquiredAt: new Date().toISOString() };
    atomicWriteJson(p, content);

    // Verify we are the holder (detect rename race).
    const now = readLock(p);
    if (now && now.pid === process.pid && now.taskId === taskId) {
      return {
        release(): void {
          try {
            const cur = readLock(p);
            if (cur && cur.pid === process.pid) {
              unlinkSync(p);
            }
          } catch {
            // Best effort; stale-lock recovery handles orphans.
          }
        },
      };
    }
    // Lost the race — loop and re-check.
  }

  throw new LockError(`Could not acquire workspace lock after retries: ${p}`);
}

function readLock(p: string): LockContent | null {
  try {
    return JSON.parse(readFileSync(p, "utf-8")) as LockContent;
  } catch {
    return null;
  }
}

function isStaleLock(lock: LockContent): boolean {
  const age = Date.now() - new Date(lock.acquiredAt).getTime();
  if (Number.isFinite(age) && age > LOCK_STALE_MS) return true;
  // Holder process dead?
  try {
    process.kill(lock.pid, 0);
    return false; // alive
  } catch {
    return true; // ESRCH — dead
  }
}
