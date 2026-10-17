import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { TranscriptBlock } from "../src/ui/blocks.js";
import { deriveEvidence, evidenceFile, verifyCommandFrom } from "../src/learn/evidence.js";
import { learnFromSession, rejectReason, signatureOf } from "../src/learn/mine.js";
import { listProposals } from "../src/skills/proposals.js";
import { listSkills } from "../src/context/skills.js";

function block(partial: Partial<TranscriptBlock> & { kind: TranscriptBlock["kind"] }): TranscriptBlock {
  return partial as TranscriptBlock;
}

function workspace(test = "node -e \"process.exit(0)\""): string {
  const dir = mkdtempSync(join(tmpdir(), "piharness-learn-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "learn-fixture", version: "1.0.0", scripts: { test } }, null, 2));
  return dir;
}

test("verify commands are canonicalised, never taken verbatim", () => {
  assert.equal(verifyCommandFrom("cd app && npm test"), "npm test");
  assert.equal(verifyCommandFrom("npm run build"), "npm run build");
  assert.equal(verifyCommandFrom("npx tsc --noEmit"), "npx tsc --noEmit");
  assert.equal(verifyCommandFrom("rm -rf node_modules && npm test"), "npm test");
  assert.equal(verifyCommandFrom("python -m pytest -q"), "pytest");
  assert.equal(verifyCommandFrom("cargo test --all"), "cargo test");
  assert.equal(verifyCommandFrom("echo hello"), null);
  // A command that merely mentions tests is not a gate.
  assert.equal(verifyCommandFrom("grep test README.md"), null);
});

test("deriveEvidence records what happened and ignores chat-only sessions", () => {
  const blocks: TranscriptBlock[] = [
    block({ kind: "user", text: "fix the failing sum test" }),
    block({ kind: "user", text: "/status" }),
    block({ kind: "tool", name: "read", detail: "src/sum.ts", status: "ok", output: [], truncated: false }),
    block({ kind: "tool", name: "edit", detail: "src/sum.ts", status: "ok", output: [], truncated: false }),
    block({ kind: "tool", name: "bash", detail: "npm test", status: "error", output: [], truncated: false }),
    block({ kind: "tool", name: "bash", detail: "npm test", status: "ok", output: [], truncated: false }),
  ];
  const e = deriveEvidence(blocks, { cwd: "/repo", id: "s1", at: "2026-10-17T00:00:00.000Z" })!;
  assert.equal(e.id, "s1");
  assert.deepEqual(e.goals, ["fix the failing sum test"]);
  assert.deepEqual(e.changedPaths, ["src/sum.ts"]);
  assert.deepEqual(e.verifyCommands, ["npm test"]);
  assert.deepEqual(e.failedVerify, []); // it later passed, so not a failure
  assert.equal(e.toolCalls, 4);
  assert.equal(e.errors, 1);

  assert.equal(deriveEvidence([block({ kind: "user", text: "hi" })], { cwd: "/repo" }), null);
});

test("a session without a passing gate cannot teach anything", () => {
  const base = {
    schemaVersion: 1,
    id: "s",
    at: "2026-10-17T00:00:00.000Z",
    cwd: "/repo",
    goals: ["x"],
    tools: [{ name: "bash", detail: "npm test", status: "error" as const }],
    changedPaths: ["src/a.ts"],
    verifyCommands: [],
    failedVerify: ["npm test"],
    toolCalls: 1,
    errors: 1,
  };
  assert.match(rejectReason(base), /verification failed/);
  assert.match(rejectReason({ ...base, changedPaths: [] }), /no files were changed/);
  assert.match(rejectReason({ ...base, toolCalls: 0 }), /no tool calls/);
  assert.equal(rejectReason({ ...base, verifyCommands: ["npm test"], failedVerify: [] }), "");
});

test("signature ignores exploration but tracks the procedure and its gate", () => {
  const mk = (tools: string[], verify: string[]) => ({
    schemaVersion: 1,
    id: "s",
    at: "2026-10-17T00:00:00.000Z",
    cwd: "/r",
    goals: ["x"],
    tools: tools.map((n) => ({ name: n, detail: "", status: "ok" as const })),
    changedPaths: ["a.ts"],
    verifyCommands: verify,
    failedVerify: [],
    toolCalls: tools.length,
    errors: 0,
  });
  const a = signatureOf(mk(["read", "edit", "bash"], ["npm test"]));
  assert.equal(a, signatureOf(mk(["grep", "edit", "bash"], ["npm test"])));
  assert.notEqual(a, signatureOf(mk(["edit", "bash"], ["npm run build"])));
});

test("first session drafts, second reinforces and auto-promotes, failures block", () => {
  const dir = workspace();
  try {
    const evidence = (id: string) => ({
      schemaVersion: 1,
      id,
      at: "2026-10-17T00:00:00.000Z",
      cwd: dir,
      goals: ["fix the failing sum test"],
      tools: [
        { name: "edit", detail: "src/sum.ts", status: "ok" as const },
        { name: "bash", detail: "npm test", status: "ok" as const },
      ],
      changedPaths: ["src/sum.ts"],
      verifyCommands: ["npm test"],
      failedVerify: [],
      toolCalls: 2,
      errors: 0,
    });

    const first = learnFromSession(dir, evidence("s1"));
    assert.equal(first.action, "proposed");
    assert.equal(first.evidenceCount, 1);
    assert.ok(existsSync(evidenceFile(dir, "s1")), "evidence is stored for audit");
    const draft = listProposals(dir)[0];
    assert.equal(draft.status, "proposed");
    assert.equal(listSkills(dir).length, 0, "drafts are inert");

    const second = learnFromSession(dir, evidence("s2"));
    assert.equal(second.action, "promoted");
    assert.equal(second.evidenceCount, 2);
    const promoted = listProposals(dir)[0];
    assert.equal(promoted.status, "approved");
    assert.equal(promoted.autoPromoted, true);
    const skills = listSkills(dir);
    assert.equal(skills.length, 1);
    const md = readFileSync(skills[0].path, "utf8");
    assert.match(md, /## Steps that worked/);
    assert.match(md, /npm test/);

    // Replaying the same session must not inflate the evidence count.
    const again = learnFromSession(dir, evidence("s2"));
    assert.equal(again.action, "none");
    assert.equal(listProposals(dir)[0].evidenceCount, 2);

    // A broken workspace means the draft must not be promoted a second time.
    const broken = workspace("node -e \"process.exit(1)\"");
    try {
      const p1 = learnFromSession(broken, { ...evidence("b1"), cwd: broken });
      assert.equal(p1.action, "proposed");
      const p2 = learnFromSession(broken, { ...evidence("b2"), cwd: broken });
      assert.equal(p2.action, "blocked");
      assert.equal(listSkills(broken).length, 0);
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("--no-promote keeps the draft, --dry-run writes nothing", () => {
  const dir = workspace();
  try {
    const e = {
      schemaVersion: 1,
      id: "d1",
      at: "2026-10-17T00:00:00.000Z",
      cwd: dir,
      goals: ["add a helper"],
      tools: [{ name: "write", detail: "src/a.ts", status: "ok" as const }],
      changedPaths: ["src/a.ts"],
      verifyCommands: ["npm test"],
      failedVerify: [],
      toolCalls: 1,
      errors: 0,
    };
    const dry = learnFromSession(dir, { ...e, id: "dry" }, { dryRun: true });
    assert.equal(dry.action, "proposed");
    assert.equal(listProposals(dir).length, 0);
    assert.ok(!existsSync(join(dir, ".harness", "state", "sessions")), "dry run stores nothing");

    learnFromSession(dir, e, { autoPromote: false });
    learnFromSession(dir, { ...e, id: "d2" }, { autoPromote: false });
    const p = listProposals(dir)[0];
    assert.equal(p.status, "proposed");
    assert.equal(p.evidenceCount, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
