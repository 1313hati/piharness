/**
 * Deterministic tests for the task store: atomic writes, schema rejection,
 * workspace lock with stale-lock recovery.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  atomicWriteJson,
  saveTask,
  loadTask,
  listTaskIds,
  findActiveTask,
  acquireLock,
  LockError,
  SchemaError,
  taskPath,
  stateDir,
} from "../src/task/store.ts";
import { newTaskRecord, TASK_SCHEMA_VERSION, type TaskRecord } from "../src/task/types.ts";

function tmpWorkspace(): string {
  return mkdtempSync(join(tmpdir(), "piharness-task-"));
}

function sampleRecord(id: string, workspace: string): TaskRecord {
  return newTaskRecord(
    id,
    "Fix the off-by-one bug",
    [{ id: "c1", description: "npm test passes", command: "npm test" }],
    workspace,
    { maxToolCalls: 40, maxTaskMinutes: 20, maxRepairCycles: 2 },
    "abc123",
    ["pre-existing-dirty.txt"],
  );
}

test("atomicWriteJson writes valid JSON and leaves no temp files", () => {
  const dir = tmpWorkspace();
  try {
    const p = join(dir, "sub", "data.json");
    atomicWriteJson(p, { hello: "world", n: 42 });
    const parsed = JSON.parse(readFileSync(p, "utf-8"));
    assert.deepEqual(parsed, { hello: "world", n: 42 });
    const files = readdirSync(join(dir, "sub"));
    assert.deepEqual(files, ["data.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveTask + loadTask roundtrip preserves the record", () => {
  const ws = tmpWorkspace();
  try {
    const rec = sampleRecord("t1", ws);
    rec.phase = "implementing";
    saveTask(ws, rec);
    const loaded = loadTask(ws, "t1");
    assert.equal(loaded.id, "t1");
    assert.equal(loaded.phase, "implementing");
    assert.equal(loaded.startHead, "abc123");
    assert.deepEqual(loaded.baselineDirtyPaths, ["pre-existing-dirty.txt"]);
    assert.equal(loaded.schemaVersion, TASK_SCHEMA_VERSION);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadTask throws on missing task", () => {
  const ws = tmpWorkspace();
  try {
    assert.throws(() => loadTask(ws, "nope"), /Task not found/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadTask rejects corrupt JSON without overwriting", () => {
  const ws = tmpWorkspace();
  try {
    const p = taskPath(ws, "bad");
    mkdirSync(join(ws, ".harness", "state", "tasks"), { recursive: true });
    writeFileSync(p, "{ not json", "utf-8");
    assert.throws(() => loadTask(ws, "bad"), SchemaError);
    // original content untouched
    assert.equal(readFileSync(p, "utf-8"), "{ not json");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("loadTask rejects unknown newer schema version", () => {
  const ws = tmpWorkspace();
  try {
    const rec = sampleRecord("future", ws);
    rec.schemaVersion = 99;
    saveTask(ws, rec);
    assert.throws(() => loadTask(ws, "future"), SchemaError);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("listTaskIds and findActiveTask", () => {
  const ws = tmpWorkspace();
  try {
    const a = sampleRecord("a", ws);
    a.phase = "completed";
    saveTask(ws, a);
    const b = sampleRecord("b", ws);
    b.phase = "verifying";
    saveTask(ws, b);
    assert.deepEqual(listTaskIds(ws).sort(), ["a", "b"]);
    const active = findActiveTask(ws);
    assert.ok(active);
    assert.equal(active.id, "b");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("acquireLock + release", () => {
  const ws = tmpWorkspace();
  try {
    const lock = acquireLock(ws, "t1");
    assert.ok(existsSync(join(stateDir(ws), "workspace.lock")));
    lock.release();
    assert.ok(!existsSync(join(stateDir(ws), "workspace.lock")));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("second lock while held throws LockError", () => {
  const ws = tmpWorkspace();
  try {
    const lock = acquireLock(ws, "t1");
    try {
      assert.throws(() => acquireLock(ws, "t2"), LockError);
    } finally {
      lock.release();
    }
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("stale lock (dead pid) is recovered", () => {
  const ws = tmpWorkspace();
  try {
    // Simulate a lock held by a dead process.
    const p = join(stateDir(ws), "workspace.lock");
    mkdirSync(join(ws, ".harness", "state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ pid: 99999999, taskId: "dead", acquiredAt: new Date().toISOString() }),
      "utf-8",
    );
    const lock = acquireLock(ws, "t1");
    lock.release();
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("fresh lock (live pid) is NOT recovered", () => {
  const ws = tmpWorkspace();
  try {
    const p = join(stateDir(ws), "workspace.lock");
    mkdirSync(join(ws, ".harness", "state"), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ pid: process.pid, taskId: "other", acquiredAt: new Date().toISOString() }),
      "utf-8",
    );
    assert.throws(() => acquireLock(ws, "t1"), LockError);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
