/**
 * M5 evaluation harness: scenario loading/validation, fixture isolation,
 * manifest recording. Task execution is injected, so no model is needed.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EvalError,
  loadScenario,
  listScenarios,
  runScenario,
  SCENARIO_MANIFEST_VERSION,
} from "../src/eval/index.ts";
import type { ScenarioRunner } from "../src/eval/index.ts";
import type { TaskLimits, TaskRecord } from "../src/task/types.ts";

const DEFAULTS: TaskLimits = { maxToolCalls: 40, maxTaskMinutes: 20, maxRepairCycles: 2 };

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "eval-test-"));
}

/** A repo with one fixture and one scenario; returns the repo root. */
function makeRepo(scenarioExtra: Record<string, unknown> = {}): string {
  const repo = tmp();
  const fixture = join(repo, "evals", "fixtures", "demo");
  mkdirSync(join(fixture, "src"), { recursive: true });
  writeFileSync(join(fixture, "src", "a.txt"), "fixture\n");
  mkdirSync(join(fixture, "node_modules", "junk"), { recursive: true });
  writeFileSync(join(fixture, "node_modules", "junk", "index.js"), "noise\n");
  mkdirSync(join(fixture, ".git"), { recursive: true });
  writeFileSync(join(fixture, ".git", "EVAL_MARKER"), "must not be copied\n");
  const dir = join(repo, "evals", "scenarios");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "demo.json"),
    JSON.stringify({
      schemaVersion: 1,
      name: "demo",
      description: "demo scenario",
      fixture: "../fixtures/demo",
      goal: "make the demo pass",
      checks: [{ description: "demo passes", command: "true" }],
      ...scenarioExtra,
    }),
  );
  return repo;
}

function record(over: Partial<TaskRecord> = {}): TaskRecord {
  return {
    schemaVersion: 1,
    id: "task-x",
    goal: "make the demo pass",
    checks: [{ id: "c1", description: "demo passes", command: "true" }],
    phase: "completed",
    workspace: "/tmp/ws",
    startHead: null,
    baselineDirtyPaths: [],
    piSessionId: null,
    piSessionFile: null,
    model: "local/qwen38",
    limits: DEFAULTS,
    budgets: { toolCallsUsed: 3, secondsUsed: 7, repairCyclesUsed: 0 },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    validationResults: ["c1: demo passes — PASS"],
    changedPaths: ["src/a.txt"],
    ...over,
  };
}

// ─── Loading ───────────────────────────────────────────────────────────────────

test("scenario: load resolves the fixture relative to the scenario file", () => {
  const repo = makeRepo();
  try {
    const [s] = listScenarios(repo);
    assert.equal(s.name, "demo");
    assert.equal(s.fixtureDir, join(repo, "evals", "fixtures", "demo"));
    assert.deepEqual(s.checks, [{ id: "c1", description: "demo passes", command: "true" }]);
    assert.deepEqual(s.limits, {});
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("scenario: limits are parsed and validated", () => {
  const repo = makeRepo({ limits: { maxToolCalls: 5 } });
  try {
    assert.deepEqual(listScenarios(repo)[0].limits, { maxToolCalls: 5 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
  const bad = makeRepo({ limits: { maxToolCalls: 0 } });
  try {
    assert.throws(() => listScenarios(bad), EvalError);
  } finally {
    rmSync(bad, { recursive: true, force: true });
  }
});

test("scenario: invalid definitions are rejected with EvalError", () => {
  const cases: Array<Record<string, unknown>> = [
    { name: "bad name!" },
    { fixture: "../fixtures/missing" },
    { goal: "" },
    { checks: [] },
    { schemaVersion: 99 },
  ];
  for (const extra of cases) {
    const repo = makeRepo(extra);
    try {
      assert.throws(() => listScenarios(repo), EvalError, JSON.stringify(extra));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  }
});

test("scenario: missing scenarios directory → empty list", () => {
  const repo = tmp();
  try {
    assert.deepEqual(listScenarios(repo), []);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

// ─── Running ───────────────────────────────────────────────────────────────────

test("run: copies the fixture (minus .git/node_modules), records a passing manifest", async () => {
  const repo = makeRepo();
  try {
    const [scenario] = listScenarios(repo);
    let seenWorkspace = "";
    const runner: ScenarioRunner = async ({ workspace }) => {
      seenWorkspace = workspace;
      assert.ok(existsSync(join(workspace, "src", "a.txt")), "fixture file copied");
      assert.equal(existsSync(join(workspace, "node_modules")), false, "node_modules excluded");
      assert.equal(
        existsSync(join(workspace, ".git", "EVAL_MARKER")),
        false,
        "fixture .git contents excluded (the run workspace gets its own repo)",
      );
      writeFileSync(join(workspace, "src", "a.txt"), "fixed by agent\n");
      return { record: record({ workspace }), terminal: true };
    };
    const { manifest, runDir } = await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      runner,
      defaults: DEFAULTS,
    });
    assert.equal(manifest.kind, "scenario");
    assert.equal(manifest.schemaVersion, SCENARIO_MANIFEST_VERSION);
    assert.equal(manifest.passed, true);
    assert.equal(manifest.phase, "completed");
    assert.deepEqual(manifest.budgets, { toolCallsUsed: 3, secondsUsed: 7, repairCyclesUsed: 0 });
    assert.equal(manifest.workspace.endsWith(join("work")), true);
    assert.equal(seenWorkspace.endsWith(join("work")), true);

    // Fixture source untouched by the run.
    assert.equal(readFileSync(join(scenario.fixtureDir, "src", "a.txt"), "utf8"), "fixture\n");
    // Manifest on disk matches the returned one.
    const onDisk = JSON.parse(readFileSync(join(runDir, "manifest.json"), "utf8"));
    assert.deepEqual(onDisk, JSON.parse(JSON.stringify(manifest)));
    assert.equal(onDisk.passed, true);
    assert.deepEqual(onDisk.checks, [{ id: "c1", description: "demo passes", command: "true" }]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run: failing task → passed=false, phase and outcome recorded", async () => {
  const repo = makeRepo();
  try {
    const [scenario] = listScenarios(repo);
    const { manifest } = await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      defaults: DEFAULTS,
      runner: async ({ workspace }) => ({
        record: record({ workspace, phase: "failed", outcome: "repair budget exhausted" }),
        terminal: true,
      }),
    });
    assert.equal(manifest.passed, false);
    assert.equal(manifest.phase, "failed");
    assert.equal(manifest.outcome, "repair budget exhausted");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run: a crashing runner is recorded, not thrown", async () => {
  const repo = makeRepo();
  try {
    const [scenario] = listScenarios(repo);
    const { manifest, runDir } = await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      defaults: DEFAULTS,
      runner: async () => {
        throw new Error("backend unreachable");
      },
    });
    assert.equal(manifest.phase, "error");
    assert.equal(manifest.passed, false);
    assert.match(manifest.outcome ?? "", /backend unreachable/);
    assert.equal(existsSync(join(runDir, "manifest.json")), true);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run: scenario limits override harness defaults", async () => {
  const repo = makeRepo({ limits: { maxToolCalls: 5, maxRepairCycles: 0 } });
  try {
    const [scenario] = listScenarios(repo);
    let seen: TaskLimits | null = null;
    await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      defaults: DEFAULTS,
      runner: async ({ workspace, limits }) => {
        seen = limits;
        return { record: record({ workspace }), terminal: true };
      },
    });
    assert.deepEqual(seen, { maxToolCalls: 5, maxTaskMinutes: 20, maxRepairCycles: 0 });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("run: project memory and approved skills are copied into the run workspace", async () => {
  const repo = makeRepo();
  try {
    mkdirSync(join(repo, ".harness", "skills", "demo-skill"), { recursive: true });
    writeFileSync(join(repo, ".harness", "skills", "demo-skill", "SKILL.md"), "# Demo\nDo the demo.\n");
    writeFileSync(join(repo, ".harness", "memory.json"), JSON.stringify({ version: 1, facts: [] }));
    const [scenario] = listScenarios(repo);
    let copied = { memory: false, skill: false };
    const { manifest } = await runScenario({
      repoRoot: repo,
      scenario,
      model: "local/qwen38",
      defaults: DEFAULTS,
      runner: async ({ workspace }) => {
        copied = {
          memory: existsSync(join(workspace, ".harness", "memory.json")),
          skill: existsSync(join(workspace, ".harness", "skills", "demo-skill", "SKILL.md")),
        };
        return { record: record({ workspace }), terminal: true };
      },
    });
    assert.deepEqual(copied, { memory: true, skill: true });
    assert.deepEqual(manifest.contextSkills, ["demo-skill"]);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
