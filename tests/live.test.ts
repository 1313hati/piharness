import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { clearLiveState, describeLive, liveStatePath, readLiveState, writeLiveState } from "../src/ui/live.js";
import type { LiveState } from "../src/ui/live.js";

function state(partial: Partial<LiveState> = {}): LiveState {
  return {
    version: 1,
    pid: process.pid,
    cwd: "/repo",
    model: "local/qwen38",
    startedAt: new Date(Date.now() - 65_000).toISOString(),
    updatedAt: new Date().toISOString(),
    phase: "generating",
    idleMs: 1200,
    rate: 12.4,
    streamedTokens: 2400,
    toolCalls: 3,
    tokens: 8123,
    ...partial,
  };
}

test("live state round-trips and describes an active session", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-live-"));
  try {
    writeLiveState(dir, state());
    const live = readLiveState(dir)!;
    assert.equal(live.alive, true);
    assert.ok(live.ageMs < 2_000);
    const line = describeLive(live);
    assert.match(line, new RegExp(`pid ${process.pid}`));
    assert.match(line, /generating/);
    assert.match(line, /12\.4 t\/s/);
    assert.match(line, /2400 tok/);
    assert.match(line, /\/repo/);
    assert.doesNotMatch(line, /stalled|warning/);

    clearLiveState(dir, process.pid);
    assert.equal(readLiveState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a dead pid is reported as stale, and a silent turn as stalled", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-live-"));
  try {
    writeLiveState(dir, state({ pid: 999_999 }));
    const dead = readLiveState(dir)!;
    assert.equal(dead.alive, false);
    assert.match(describeLive(dead), /\(dead\)/);
    assert.match(describeLive(dead), /stale/);

    writeLiveState(dir, state({ idleMs: 31_000 }));
    assert.match(describeLive(readLiveState(dir)!), /no events 31s/);
    assert.match(describeLive(readLiveState(dir)!), /stalled: no output/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("clearLiveState refuses to delete another process's file", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-live-"));
  try {
    writeLiveState(dir, state({ pid: 999_999 }));
    clearLiveState(dir, process.pid);
    assert.ok(readLiveState(dir), "file owned by another pid survives");
    clearLiveState(dir, 999_999);
    assert.equal(readLiveState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt state file is ignored instead of crashing ps", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-live-"));
  try {
    writeFileSync(liveStatePath(dir), "{not json");
    assert.equal(readLiveState(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
