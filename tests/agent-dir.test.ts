import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { applyOutputBudget, defaultAgentDir, ensureAgentDir, outputBudget } from "../src/pi/agent-dir.js";

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

function catalog(maxTokens: number): string {
  return JSON.stringify({
    providers: {
      local: { baseUrl: "http://127.0.0.1:8080/v1", apiKey: "local", models: [{ id: "qwen38", maxTokens }] },
      cloud: { baseUrl: "https://api.example.com", apiKey: "sk-x", models: [{ id: "m", maxTokens: 4096 }] },
    },
  });
}

test("applyOutputBudget: raises local maxTokens, leaves remote models alone", () => {
  const root = scratch();
  try {
    const path = join(root, "models.json");
    writeFileSync(path, catalog(8192));
    assert.equal(applyOutputBudget(path, 16384), true);
    const out = JSON.parse(readFileSync(path, "utf8"));
    assert.equal(out.providers.local.models[0].maxTokens, 16384);
    assert.equal(out.providers.cloud.models[0].maxTokens, 4096, "remote budget untouched");
    assert.equal(applyOutputBudget(path, 16384), false, "second call is a no-op");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("applyOutputBudget: never lowers a larger user setting", () => {
  const root = scratch();
  try {
    const path = join(root, "models.json");
    writeFileSync(path, catalog(32768));
    assert.equal(applyOutputBudget(path, 16384), false);
    assert.equal(JSON.parse(readFileSync(path, "utf8")).providers.local.models[0].maxTokens, 32768);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("outputBudget: env override, sane default", () => {
  const saved = process.env.PIHARNESS_MAX_OUTPUT;
  try {
    delete process.env.PIHARNESS_MAX_OUTPUT;
    assert.equal(outputBudget(), 16384);
    process.env.PIHARNESS_MAX_OUTPUT = "24576";
    assert.equal(outputBudget(), 24576);
    process.env.PIHARNESS_MAX_OUTPUT = "nonsense";
    assert.equal(outputBudget(), 16384);
  } finally {
    if (saved === undefined) delete process.env.PIHARNESS_MAX_OUTPUT;
    else process.env.PIHARNESS_MAX_OUTPUT = saved;
  }
});
