import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_SETTINGS,
  loadSettings,
  renderSettings,
  setSetting,
  settingsPath,
} from "../src/config/settings.js";

test("missing settings file yields defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-settings-"));
  try {
    assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("settings set validates and persists only known keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-settings-"));
  try {
    assert.equal(setSetting(dir, "ui.gpu", "false").ok, true);
    assert.equal(setSetting(dir, "learn.minEvidence", "3").ok, true);
    assert.equal(setSetting(dir, "learn.autoPromote", "off").ok, true);
    const loaded = loadSettings(dir);
    assert.equal(loaded.ui.gpu, false);
    assert.equal(loaded.learn.minEvidence, 3);
    assert.equal(loaded.learn.autoPromote, false);

    const bad = setSetting(dir, "learn.minEvidence", "zero");
    assert.equal(bad.ok, false);
    assert.match(!bad.ok ? bad.error : "", />= 1/);
    assert.equal(setSetting(dir, "ui.gpu", "maybe").ok, false);
    assert.equal(setSetting(dir, "ui.theme", "light").ok, false);
    // Rejected writes leave the file untouched.
    assert.equal(loadSettings(dir).learn.minEvidence, 3);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a corrupt settings file falls back to defaults, not a crash", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-settings-"));
  try {
    writeFileSync(settingsPath(dir), "{oops");
    assert.deepEqual(loadSettings(dir), DEFAULT_SETTINGS);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderSettings lists every knob with its current value", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-settings-"));
  try {
    const text = renderSettings(loadSettings(dir), settingsPath(dir)).join("\n");
    for (const key of ["ui.gpu", "learn.onExit", "learn.autoPromote", "learn.minEvidence"]) {
      assert.match(text, new RegExp(key));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("partial files merge with defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "piharness-settings-"));
  try {
    writeFileSync(settingsPath(dir), JSON.stringify({ learn: { minEvidence: 4 } }));
    const loaded = loadSettings(dir);
    assert.equal(loaded.learn.minEvidence, 4);
    assert.equal(loaded.learn.onExit, true);
    assert.equal(loaded.ui.gpu, true);
    assert.ok(readFileSync(settingsPath(dir), "utf8").includes("minEvidence"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
