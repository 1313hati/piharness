/**
 * M6 evaluation history: append-only JSONL, tolerant reads, aggregation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
    variant: "skills",
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
    { at: "1", scenario: "a", variant: "skills", passed: true, phase: "completed", toolCalls: 9, repairCycles: 1, seconds: 30, model: "m", runDir: "r1" },
    { at: "2", scenario: "a", variant: "skills", passed: false, phase: "failed", toolCalls: 20, repairCycles: 2, seconds: 80, model: "m", runDir: "r2" },
    { at: "3", scenario: "a", variant: "skills", passed: true, phase: "completed", toolCalls: 5, repairCycles: 0, seconds: 45, model: "m", runDir: "r3" },
    { at: "4", scenario: "b", variant: "skills", passed: false, phase: "error", toolCalls: 0, repairCycles: 0, seconds: 2, model: "m", runDir: "r4" },
  ];
  const [a, b] = summarizeHistory(entries);
  assert.equal(a.scenario, "a");
  assert.equal(a.runs, 3);
  assert.equal(a.modelRuns, 3, "a failed-checks run that used 20 tools did reach the model");
  assert.equal(a.passed, 2);
  assert.equal(Math.round(a.passRate * 100), 67);
  assert.equal(a.bestToolCalls, 5);
  assert.equal(a.avgToolCalls.toFixed(1), "11.3");
  assert.equal(a.bestSeconds, 30);
  assert.equal(a.last.runDir, "r3", "last entry is the most recent append");
  assert.equal(b.runs, 1);
  assert.equal(b.modelRuns, 0, "no tools + no pass = never reached the backend");
  assert.equal(b.passRate, 0);
  // b's only run never called a tool (backend unreachable): no cost data,
  // and definitely not "best tools 0".
  assert.equal(b.bestToolCalls, null);
  assert.equal(b.avgToolCalls, null);
  assert.equal(b.bestSeconds, null);
  assert.equal(b.last.phase, "error");
});

test("history: arms are summarized separately, never pooled", () => {
  const entries: HistoryEntry[] = [
    { at: "1", scenario: "offbyone-fix", variant: "no-skills", passed: false, phase: "failed", toolCalls: 20, repairCycles: 2, seconds: 90, model: "m", runDir: "r1" },
    { at: "2", scenario: "offbyone-fix", variant: "skills", passed: true, phase: "completed", toolCalls: 6, repairCycles: 0, seconds: 40, model: "m", runDir: "r2" },
    { at: "3", scenario: "offbyone-fix", variant: "no-skills", passed: false, phase: "failed", toolCalls: 18, repairCycles: 2, seconds: 85, model: "m", runDir: "r3" },
  ];
  const summaries = summarizeHistory(entries);
  assert.equal(summaries.length, 2, "two arms, two rows");
  assert.deepEqual(
    summaries.map((s) => `${s.scenario}[${s.variant}]:${s.runs}/${s.passed}`),
    ["offbyone-fix[no-skills]:2/0", "offbyone-fix[skills]:1/1"],
  );
  assert.equal(summaries[0].bestToolCalls, 18, "baseline best of its own runs");
  assert.equal(summaries[1].bestToolCalls, 6);
});

test("history: a run records its variant end to end", async () => {
  const repo = tmp();
  try {
    const fixture = join(repo, "evals", "fixtures", "demo");
    mkdirSync(join(fixture, "src"), { recursive: true });
    writeFileSync(join(fixture, "src", "a.txt"), "x\n");
    // An approved skill in the repo, so the arms differ in more than a label.
    mkdirSync(join(repo, ".harness", "skills", "gate-order"), { recursive: true });
    writeFileSync(
      join(repo, ".harness", "skills", "gate-order", "SKILL.md"),
      "# Gate order\n\n1. typecheck\n2. test\n",
    );
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
    const seen: Array<{ variant: string; skills: string[] }> = [];
    const runner = async ({ workspace }: { workspace: string }) => {
      const dir = join(workspace, ".harness", "skills");
      seen.push({
        variant: "captured",
        // The baseline arm is defined by this directory being absent.
        skills: existsSync(dir) ? readdirSync(dir).filter((n) => !n.startsWith(".")) : [],
      });
      return { record, terminal: true };
    };
    const withSkills = await runScenario({ repoRoot: repo, scenario, model: "m", defaults: DEFAULTS, runner });
    const baseline = await runScenario({
      repoRoot: repo,
      scenario,
      model: "m",
      defaults: DEFAULTS,
      variant: "no-skills",
      runner,
    });

    assert.deepEqual(seen[0].skills, ["gate-order"], "skills arm carries the promoted skill");
    assert.deepEqual(seen[1].skills, [], "baseline arm carries none");
    assert.equal(withSkills.manifest.variant, "skills");
    assert.deepEqual(withSkills.manifest.contextSkills, ["gate-order"]);
    assert.equal(baseline.manifest.variant, "no-skills");
    assert.deepEqual(baseline.manifest.contextSkills, []);
    assert.match(baseline.runDir, /demo-noskills-/);
    // Memory is not part of the arm: both get it.
    const entries = readHistory(repo);
    assert.deepEqual(entries.map((e) => e.variant), ["skills", "no-skills"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
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
