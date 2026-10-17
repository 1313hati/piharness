/**
 * M6 evaluation history: append-only JSONL, tolerant reads, aggregation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendHistory,
  historyPath,
  readHistory,
  summarizeHistory,
  runScenario,
  listScenarios,
  type HistoryEntry,
  type ScenarioManifest,
} from "../src/eval/index.ts";
import type { TaskLimits, TaskRecord } from "../src/task/types.ts";

const DEFAULTS: TaskLimits = { maxToolCalls: 40, maxTaskMinutes: 20, maxRepairCycles: 2 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eval-hist-"));
}

function manifest(over: Partial<ScenarioManifest> = {}): ScenarioManifest {
  return {
    schemaVersion: 1,
    kind: "scenario",
    scenario: "demo",
    at: "2026-10-17T10:00:00.000Z",
    fixture: "../fixtures/demo",
    workspace: ".harness/state/evals/demo-1/work",
    model: "local/qwen38",
    phase: "completed",
    passed: true,
    taskId: "task-1",
    budgets: { toolCallsUsed: 4, secondsUsed: 12, repairCyclesUsed: 0 },
    durationMs: 12_300,
    checks: [{ id: "c1", description: "demo passes", command: "true" }],
    contextSkills: [],
    validationResults: [],
    ...over,
  };
}

test("history: append writes one JSONL line per run", () => {
  const repo = tmp();
  try {
    appendHistory(repo, manifest(), ".harness/state/evals/demo-1");
    appendHistory(repo, manifest({ at: "2026-10-17T11:00:00.000Z", passed: false, phase: "failed" }), ".harness/state/evals/demo-2");
    const lines = readFileSync(historyPath(repo), "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    const entries = readHistory(repo);
    assert.equal(entries.length, 2);
    assert.equal(entries[0].toolCalls, 4);
    assert.equal(entries[0].seconds, 12.3);
    assert.equal(entries[1].passed, false);
    assert.equal(entries[1].phase, "failed");
    assert.equal(entries[1].runDir, ".harness/state/evals/demo-2");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("history: reading a missing history is empty, malformed lines are skipped", () => {
  const repo = tmp();
  try {
    assert.deepEqual(readHistory(repo), []);
    mkdirSync(join(repo, ".harness", "state", "evals"), { recursive: true });
    appendFileSync(historyPath(repo), '{"scenario":"demo","passed":true,"at":"t"}\n');
    appendFileSync(historyPath(repo), "{not json at all\n");
    appendFileSync(historyPath(repo), '{"scenario":"demo2","passed":"yes","at":"t"}\n');
    appendFileSync(historyPath(repo), "\n");
    const entries = readHistory(repo);
    assert.equal(entries.length, 1, "only the well-formed entry survives");
    assert.equal(entries[0].scenario, "demo");
    assert.equal(entries[0].toolCalls, 0, "missing counters default to 0");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("history: summarize computes pass rate and cost per scenario", () => {
  const entries: HistoryEntry[] = [
    { at: "1", scenario: "a", passed: true, phase: "completed", toolCalls: 9, repairCycles: 1, seconds: 30, model: "m", runDir: "r1" },
    { at: "2", scenario: "a", passed: false, phase: "failed", toolCalls: 20, repairCycles: 2, seconds: 80, model: "m", runDir: "r2" },
    { at: "3", scenario: "a", passed: true, phase: "completed", toolCalls: 5, repairCycles: 0, seconds: 45, model: "m", runDir: "r3" },
    { at: "4", scenario: "b", passed: false, phase: "error", toolCalls: 0, repairCycles: 0, seconds: 2, model: "m", runDir: "r4" },
  ];
  const [a, b] = summarizeHistory(entries);
  assert.equal(a.scenario, "a");
  assert.equal(a.runs, 3);
  assert.equal(a.passed, 2);
  assert.equal(Math.round(a.passRate * 100), 67);
  assert.equal(a.bestToolCalls, 5);
  assert.equal(a.avgToolCalls.toFixed(1), "11.3");
  assert.equal(a.bestSeconds, 30);
  assert.equal(a.last.runDir, "r3", "last entry is the most recent append");
  assert.equal(b.runs, 1);
  assert.equal(b.passRate, 0);
  assert.equal(b.last.phase, "error");
});

test("history: a real scenario run appends itself", async () => {
  const repo = tmp();
  try {
    const fixture = join(repo, "evals", "fixtures", "demo");
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "src", "a.txt"), "x\n");
    mkdirSync(join(repo, "evals", "scenarios"), { recursive: true });
    writeFileSync(
      join(repo, "evals", "scenarios", "demo.json"),
      JSON.stringify({
        schemaVersion: 1,
        name: "demo",
        fixture: "../fixtures/demo",
        goal: "g",
        checks: [{ description: "d", command: "true" }],
      }),
    );
    const [scenario] = listScenarios(repo);
    const record: TaskRecord = {
      schemaVersion: 1,
      id: "task-1",
      goal: "g",
      checks: scenario.checks,
      phase: "completed",
      workspace: "/ws",
      startHead: null,
      baselineDirtyPaths: [],
      piSessionId: null,
      piSessionFile: null,
      model: "local/qwen38",
      limits: DEFAULTS,
      budgets: { toolCallsUsed: 2, secondsUsed: 3, repairCyclesUsed: 0 },
      createdAt: "2026-10-17T10:00:00.000Z",
      updatedAt: "2026-10-17T10:00:00.000Z",
      validationResults: ["c1: d — PASS"],
      changedPaths: [],
    };
    await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      defaults: DEFAULTS,
      runner: async () => ({ record, terminal: true }),
    });
    const entries = readHistory(repo);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].scenario, "demo");
    assert.equal(entries[0].passed, true);
    assert.equal(entries[0].toolCalls, 2);
    assert.match(entries[0].runDir, /^\.harness\/state\/evals\/demo-/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
