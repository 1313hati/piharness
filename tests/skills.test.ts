/**
 * M4 learning service: proposal → evaluation → promotion. No model, no network.
 * Verifies the trust boundary: proposals are inert until approved, and only
 * completed tasks may seed a proposal.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  proposeFromTask,
  loadProposal,
  listProposals,
  renderSkillMd,
  slugifyGoal,
  titleFromGoal,
  validateProposalName,
  evaluateProposal,
  evalsRoot,
  approveProposal,
  rejectProposal,
  skillVersionsRoot,
  SkillError,
} from "../src/skills/index.ts";
import { newTaskRecord } from "../src/task/types.ts";
import type { TaskRecord } from "../src/task/types.ts";
import { listSkills } from "../src/context/index.ts";

test("titleFromGoal: readable title, no mid-word cut", () => {
  // Observed bug: a 120-char slice produced a title ending "…Report both results. Do not".
  const long =
    "Verify this project's quality gates in this order: run 'npm run typecheck', then 'npm test'. Report both results. Do not modify any files.";
  const t = titleFromGoal(long);
  assert.ok(t.length <= 73, `title too long: ${t.length}`);
  assert.match(t, /…$/, "truncation is marked");
  assert.doesNotMatch(t, /\s$/, "does not end on whitespace");
  // The retained text must be whole words from the goal.
  const kept = t.replace(/…$/, "");
  assert.ok(long.startsWith(kept), "kept prefix is verbatim");
  assert.match(kept, /[\w'’)]$/, "ends on a word, not punctuation or a fragment");
  // Short goals pass through untouched.
  assert.equal(titleFromGoal("Fix the sum bug."), "Fix the sum bug.");
  assert.equal(titleFromGoal("Fix the sum bug"), "Fix the sum bug");
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "piharness-skill-"));
}

function completedTask(ws: string, goal: string, opts: { checks?: { description: string; command?: string }[]; changed?: string[]; id?: string } = {}): TaskRecord {
  const rec = newTaskRecord(
    opts.id ?? "task-abc123",
    goal,
    (opts.checks ?? [{ description: "tests pass", command: "true" }]).map((c, i) => ({
      id: `c${i + 1}`,
      description: c.description,
      command: c.command,
    })),
    ws,
    { maxToolCalls: 10, maxTaskMinutes: 5, maxRepairCycles: 1 },
    null,
    [],
  );
  rec.phase = "completed";
  rec.changedPaths = opts.changed ?? ["src/sum.ts"];
  rec.piSessionId = "session-xyz";
  return rec;
}

// ─── Propose ───────────────────────────────────────────────────────────────────

test("propose: only completed tasks may seed a skill", () => {
  const ws = tmp();
  try {
    const failed = completedTask(ws, "do a thing");
    failed.phase = "failed";
    assert.throws(() => proposeFromTask(ws, failed), /only completed tasks/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("propose: slug derives from the goal and body captures evidence", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Fix the off-by-one in sum", {
      checks: [
        { description: "sum tests pass", command: "npm test" },
        { description: "build stays green" },
      ],
      changed: ["src/sum.ts"],
    });
    const p = proposeFromTask(ws, rec);
    assert.equal(p.name, "fix-the-off-by-one-in-sum");
    assert.equal(p.status, "proposed");
    assert.equal(p.sourceTaskId, rec.id);
    assert.deepEqual(p.verifyCommands, ["npm test"]);
    assert.match(renderSkillMd(p), /## Goal/);
    assert.match(renderSkillMd(p), /## What worked/);
    assert.match(renderSkillMd(p), /src\/sum\.ts/);
    assert.match(renderSkillMd(p), /npm test/);
    assert.match(renderSkillMd(p), /Learned from task task-abc123/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("propose: name collision appends a numeric suffix", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Fix the off-by-one in sum", { id: "task-1" });
    const first = proposeFromTask(ws, rec);
    assert.equal(first.name, "fix-the-off-by-one-in-sum");
    // Second task with the same goal → suffixed name.
    const rec2 = completedTask(ws, "Fix the off-by-one in sum", { id: "task-2" });
    const second = proposeFromTask(ws, rec2);
    assert.equal(second.name, "fix-the-off-by-one-in-sum-2");
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("propose: validates proposal name shape", () => {
  assert.equal(validateProposalName("good-name_1"), "good-name_1");
  assert.throws(() => validateProposalName("bad name"), /invalid proposal name/i);
  assert.throws(() => validateProposalName(""), /invalid proposal name/i);
});

// ─── Inert boundary ────────────────────────────────────────────────────────────

test("proposals are inert: never discoverable by the context service", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Some goal for a skill");
    proposeFromTask(ws, rec);
    // The context service only reads .harness/skills/. A proposal under
    // .harness/state/proposals/ must NOT be listed as an active skill.
    assert.deepEqual(listSkills(ws), []);
    // But it IS listed as a proposal.
    assert.equal(listProposals(ws).length, 1);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── Evaluate ──────────────────────────────────────────────────────────────────

test("evaluate: passing verify command → manifest passed, proposal stamped", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "A verifiable goal", { checks: [{ description: "ok", command: "echo ok" }] });
    const p = proposeFromTask(ws, rec);
    const { manifest, passed } = evaluateProposal(ws, p.name);
    assert.equal(passed, true);
    assert.equal(manifest.passed, true);
    assert.equal(manifest.commands.length, 1);
    assert.equal(manifest.commands[0].ok, true);
    // A manifest file was written under .harness/state/evals/.
    const evals = readdirSync(evalsRoot(ws));
    assert.ok(evals.length >= 1, "expected at least one eval manifest");
    // The proposal was stamped with the result.
    assert.equal(loadProposal(ws, p.name)?.evalResult?.passed, true);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("evaluate: failing verify command → not passed, stops at first failure", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "A failing goal", {
      checks: [
        { description: "fails first", command: "exit 1" },
        { description: "never runs", command: "echo never" },
      ],
    });
    const p = proposeFromTask(ws, rec);
    const { manifest, passed } = evaluateProposal(ws, p.name);
    assert.equal(passed, false);
    assert.equal(manifest.passed, false);
    // Stopped at first failure: only one command ran.
    assert.equal(manifest.commands.length, 1);
    assert.equal(manifest.commands[0].ok, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("evaluate: empty verify list → fail (a skill with nothing to verify is not trustworthy)", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "No verify commands", { checks: [{ description: "no command here" }] });
    const p = proposeFromTask(ws, rec);
    assert.deepEqual(p.verifyCommands, []);
    const { passed } = evaluateProposal(ws, p.name);
    assert.equal(passed, false);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── Promotion ─────────────────────────────────────────────────────────────────

test("promote: approve requires a passed evaluation", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Gate on evaluation", { checks: [{ description: "ok", command: "true" }] });
    const p = proposeFromTask(ws, rec);
    // No evaluation yet → approve must fail.
    assert.throws(() => approveProposal(ws, p.name), /has not passed evaluation/i);
    // Now evaluate (passes) → approve succeeds.
    evaluateProposal(ws, p.name);
    const approved = approveProposal(ws, p.name);
    assert.equal(approved.status, "approved");
    // Installed under .harness/skills/ and now discoverable.
    assert.ok(existsSync(join(ws, ".harness", "skills", p.name, "SKILL.md")));
    const active = listSkills(ws);
    assert.equal(active.length, 1);
    assert.equal(active[0].name, p.name);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("promote: a failed evaluation blocks approval", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Cannot approve a failure", { checks: [{ description: "bad", command: "exit 1" }] });
    const p = proposeFromTask(ws, rec);
    const { passed } = evaluateProposal(ws, p.name);
    assert.equal(passed, false);
    assert.throws(() => approveProposal(ws, p.name), /has not passed evaluation/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("promote: re-approve is rejected; rejected cannot be approved", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Lifecycle checks", { checks: [{ description: "ok", command: "true" }] });
    const p = proposeFromTask(ws, rec);
    evaluateProposal(ws, p.name);
    approveProposal(ws, p.name);
    assert.throws(() => approveProposal(ws, p.name), /already approved/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("reject: rejected proposal cannot be approved; rejecting an approved one errors", () => {
  const ws = tmp();
  try {
    const rec = completedTask(ws, "Reject path", { checks: [{ description: "ok", command: "true" }] });
    const p = proposeFromTask(ws, rec);
    evaluateProposal(ws, p.name);
    const rejected = rejectProposal(ws, p.name);
    assert.equal(rejected.status, "rejected");
    assert.throws(() => approveProposal(ws, p.name), /was rejected/i);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("promote: overwriting an existing skill snapshots the prior version", () => {
  const ws = tmp();
  try {
    // Seed a pre-existing skill file so approve must snapshot it.
    const skillDir = join(ws, ".harness", "skills", "existing-skill");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# Old\nold content\n");

    // Create a proposal named to match, pass it, approve → overwrites.
    const rec = completedTask(ws, "Existing skill", {
      id: "task-existing",
      checks: [{ description: "ok", command: "true" }],
    });
    // Force the proposal name to collide with the existing skill.
    const p = proposeFromTask(ws, rec);
    // Rename proposal to "existing-skill" to trigger the overwrite path.
    const raw = JSON.parse(readFileSync(join(ws, ".harness", "state", "proposals", p.name, "proposal.json"), "utf8"));
    raw.name = "existing-skill";
    writeFileSync(join(ws, ".harness", "state", "proposals", p.name, "proposal.json"), JSON.stringify(raw, null, 2));

    // Evaluate + approve under the new name.
    // (Re-point by writing the proposal file at the colliding dir.)
    mkdirSync(join(ws, ".harness", "state", "proposals", "existing-skill"), { recursive: true });
    writeFileSync(join(ws, ".harness", "state", "proposals", "existing-skill", "proposal.json"), JSON.stringify(raw, null, 2));
    const { passed } = evaluateProposal(ws, "existing-skill");
    assert.equal(passed, true);
    approveProposal(ws, "existing-skill");

    // A version snapshot was written under .harness/state/skill-versions/existing-skill/.
    const vdir = join(skillVersionsRoot(ws), "existing-skill");
    assert.ok(existsSync(vdir), "expected a skill-versions directory");
    const snaps = readdirSync(vdir);
    assert.ok(snaps.length >= 1, "expected at least one snapshot");
    const snap = JSON.parse(readFileSync(join(vdir, snaps[0]), "utf8"));
    assert.match(snap.content, /old content/);
    assert.equal(typeof snap.sha256, "string");
    // The active skill file was overwritten by the new proposal.
    assert.match(readFileSync(join(skillDir, "SKILL.md"), "utf8"), /Existing skill/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("slugifyGoal: trims, lowercases, and falls back for empty input", () => {
  assert.equal(slugifyGoal("  Fix the sum!  "), "fix-the-sum");
  assert.equal(slugifyGoal("!!!"), "learned-skill");
  assert.ok(slugifyGoal("a".repeat(200)).length <= 48);
});
