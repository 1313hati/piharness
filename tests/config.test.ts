import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, DEFAULTS } from "../src/config.ts";

function makeProject(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "piharness-cfg-"));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(dir, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, content);
  }
  return dir;
}

test("defaults when no project config and no CLI overrides", async () => {
  const dir = makeProject();
  try {
    const cfg = await loadConfig({}, dir);
    assert.equal(cfg.provider, DEFAULTS.provider);
    assert.equal(cfg.model, DEFAULTS.model);
    assert.equal(cfg.maxToolCalls, 40);
    assert.equal(cfg.maxTaskMinutes, 20);
    assert.equal(cfg.commandTimeoutSec, 120);
    assert.equal(cfg.maxRepairCycles, 2);
    assert.equal(cfg.cwd, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("project config overrides defaults", async () => {
  const dir = makeProject({
    ".harness/config.json": JSON.stringify({ provider: "other", maxToolCalls: 7 }),
  });
  try {
    const cfg = await loadConfig({}, dir);
    assert.equal(cfg.provider, "other");
    assert.equal(cfg.maxToolCalls, 7);
    // untouched keys keep defaults
    assert.equal(cfg.model, DEFAULTS.model);
    assert.equal(cfg.maxTaskMinutes, 20);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("CLI overrides project config", async () => {
  const dir = makeProject({
    ".harness/config.json": JSON.stringify({ provider: "other", maxToolCalls: 7 }),
  });
  try {
    const cfg = await loadConfig({ provider: "cli" }, dir);
    assert.equal(cfg.provider, "cli");
    // project value still wins for keys CLI did not set
    assert.equal(cfg.maxToolCalls, 7);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("undefined CLI values do not clobber defaults (regression)", async () => {
  const dir = makeProject();
  try {
    const cfg = await loadConfig({ provider: undefined, model: undefined }, dir);
    assert.equal(cfg.provider, DEFAULTS.provider);
    assert.equal(cfg.model, DEFAULTS.model);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalid project config fails loudly", async () => {
  const dir = makeProject({
    ".harness/config.json": JSON.stringify({ maxToolCalls: -1 }),
  });
  try {
    await assert.rejects(async () => await loadConfig({}, dir), /maxToolCalls/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
