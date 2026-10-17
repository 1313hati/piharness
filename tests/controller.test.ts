/**
 * Deterministic tests for the task controller: bounded repair, identical
 * failure detection, budget exhaustion. Uses fake sessions and checks —
 * no model, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "../src/task/controller.ts";
import type { TaskCheck, TaskLimits } from "../src/task/types.ts";
import type { HarnessSession, NormalizedEvent } from "../src/pi/session.ts";

const LIMITS: TaskLimits = { maxToolCalls: 40, maxTaskMinutes: 20, maxRepairCycles: 2 };
const CHECKS: TaskCheck[] = [
  { id: "c1", description: "tests pass", command: "npm test" },
];

/** Build a fake session; runPrompt is fully under test control. */
function makeOpts(workspace: string, runCheckImpl: () => boolean, prompts: string[]) {
  const session: HarnessSession = {
    sessionId: "fake-session",
    sessionFile: "/tmp/fake-session.jsonl",
    prompt: async (p: string) => {
      prompts.push(p);
    },
    abort: async () => {},
    waitForIdle: async () => {},
    isStreaming: false,
    getLastAssistantText: () => "done",
    getSessionStats: () => ({ toolCalls: 3, tokens: { input: 1, output: 1, total: 2 } }),
    subscribe: (_l: (e: NormalizedEvent) => void) => () => {},
    dispose: () => {},
  };
  return {
    session,
    prompts,
    opts: {
      workspace,
      goal: "make tests pass",
      checks: CHECKS,
      limits: LIMITS,
      model: "fake/model",
      createSession: async (_p: string) => session,
      runPrompt: async (s: HarnessSession, p: string) => {
        await s.prompt(p); // record the prompt for assertions
        return { toolCalls: 2 };
      },
      disposeSession: (_s: HarnessSession) => {},
      runCheck: async () => ({ ok: runCheckImpl(), output: "fake output" }),
    },
  };
}

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "piharness-ctl-"));
}

test("passes on first check → completed", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const { opts } = makeOpts(dir, () => true, []);
    const result = await runTask(opts);
    calls++;
    assert.equal(result.record.phase, "completed");
    assert.equal(result.terminal, true);
    assert.equal(result.record.budgets.repairCyclesUsed, 0);
    assert.ok(result.record.validationResults.some((l) => l.includes("PASS")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("fails then passes → one bounded repair cycle", async () => {
  const dir = tmp();
  try {
    let calls = 0;
    const { opts, prompts } = makeOpts(dir, () => {
      calls++;
      return calls >= 2; // first check fails, second passes
    }, []);
    const result = await runTask(opts);
    assert.equal(result.record.phase, "completed");
    assert.equal(result.record.budgets.repairCyclesUsed, 1);
    assert.equal(prompts.length, 2); // implementation + repair
    assert.match(prompts[1], /did not pass all acceptance checks/i);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repeated identical failure → failed, loop stops early", async () => {
  const dir = tmp();
  try {
    const { opts, prompts } = makeOpts(dir, () => false, []);
    const result = await runTask(opts);
    assert.equal(result.record.phase, "failed");
    assert.ok(result.record.outcome?.includes("no new evidence"));
    // implementation + one repair, then stopped on the identical second failure
    assert.equal(prompts.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("repair budget exhausted → failed with budget note", async () => {
  const dir = tmp();
  try {
    // Each check returns a *different* failure so the identical-failure stop
    // never triggers; the repair budget is what ends the loop.
    let n = 0;
    const { opts } = makeOpts(dir, () => false, []);
    opts.runCheck = async () => ({ ok: false, output: `failure-${n++}` });
    const result = await runTask(opts);
    assert.equal(result.record.phase, "failed");
    assert.ok(result.record.outcome?.includes("repair cycles"));
    assert.equal(result.record.budgets.repairCyclesUsed, LIMITS.maxRepairCycles);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
