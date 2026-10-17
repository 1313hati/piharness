import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { defaultAgentDir, ensureAgentDir } from "../src/pi/agent-dir.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "piharness-agent-"));
}

// NOTE: these tests never touch the real ~/.pi — they pass an explicit agent
// dir and an explicit seed source.

test("ensureAgentDir: seeds models.json once from the pi catalog", () => {
  const root = scratch();
  try {
    const dir = join(root, "agent");
    const seed = join(root, "pi-models.json");
    writeFileSync(seed, '{"providers":{"local":{"models":[{"id":"qwen38"}]}}}');

    const first = ensureAgentDir(dir, seed);
    assert.equal(first.seeded, true);
    assert.equal(first.modelsPath, join(dir, "models.json"));
    assert.equal(readFileSync(first.modelsPath, "utf-8"), readFileSync(seed, "utf-8"));

    // A later edit of the harness copy must survive: seeding is one-shot.
    writeFileSync(first.modelsPath, '{"providers":{}}');
    const second = ensureAgentDir(dir, seed);
    assert.equal(second.seeded, false);
    assert.equal(readFileSync(second.modelsPath, "utf-8"), '{"providers":{}}');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("ensureAgentDir: refuses to invent a catalog and says how to fix it", () => {
  const root = scratch();
  try {
    const dir = join(root, "agent");
    const missing = join(root, "nope.json");
    assert.throws(
      () => ensureAgentDir(dir, missing),
      /No model catalog at .*models\.json and nothing to seed from/,
    );
    assert.equal(existsSync(join(dir, "models.json")), false);
    // The directory itself is created, so the user has somewhere to put the file.
    assert.equal(existsSync(dir), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("defaultAgentDir: never points at the pi install, and honours the override", () => {
  const original = process.env.PIHARNESS_AGENT_DIR;
  try {
    delete process.env.PIHARNESS_AGENT_DIR;
    const fallback = defaultAgentDir();
    assert.ok(fallback.endsWith(join(".config", "piharness", "agent")), fallback);
    assert.ok(!fallback.includes(join(".pi", "agent")), fallback);

    process.env.PIHARNESS_AGENT_DIR = "/tmp/elsewhere/agent";
    assert.equal(defaultAgentDir(), "/tmp/elsewhere/agent");

    process.env.PIHARNESS_AGENT_DIR = "   ";
    assert.ok(defaultAgentDir().endsWith(join(".config", "piharness", "agent")));
  } finally {
    if (original === undefined) delete process.env.PIHARNESS_AGENT_DIR;
    else process.env.PIHARNESS_AGENT_DIR = original;
  }
});
