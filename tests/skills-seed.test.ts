import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { bundledSkillsDir, seedGlobalSkills } from "../src/pi/agent-dir.js";

function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test("bundled skills ship with the package", () => {
  const dir = bundledSkillsDir();
  for (const name of ["measure-first", "minimal-diff", "verify-before-claim"]) {
    assert.ok(existsSync(join(dir, name, "SKILL.md")), `${name}.SKILL.md missing from ${dir}`);
  }
});

test("seedGlobalSkills copies missing skills into the agent dir", () => {
  const agentDir = scratch("harness-seed-");
  try {
    const seeded = seedGlobalSkills(agentDir).sort();
    assert.deepEqual(seeded, ["measure-first", "minimal-diff", "verify-before-claim"]);
    const body = readFileSync(join(agentDir, "skills", "measure-first", "SKILL.md"), "utf-8");
    assert.match(body, /Measure the numbers/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("seedGlobalSkills never overwrites a local edit", () => {
  const agentDir = scratch("harness-seed-");
  try {
    seedGlobalSkills(agentDir);
    const path = join(agentDir, "skills", "minimal-diff", "SKILL.md");
    writeFileSync(path, "# My version\nLocal edit.\n", "utf-8");
    const seeded = seedGlobalSkills(agentDir);
    assert.deepEqual(seeded, []);
    assert.match(readFileSync(path, "utf-8"), /My version/);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});

test("seedGlobalSkills tolerates a missing source dir", () => {
  const agentDir = scratch("harness-seed-");
  try {
    assert.deepEqual(seedGlobalSkills(agentDir, join(agentDir, "nope")), []);
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
  }
});
