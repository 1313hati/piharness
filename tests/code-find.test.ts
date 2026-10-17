import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { findCode, invalidateCodeIndex, renderFindHits } from "../src/extensions/code.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-find-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(
    join(dir, "src", "levels.js"),
    ["export function loadLevel() {", "  return buildLevel(1);", "}", "function buildLevel(n) {", "  return n;", "}"].join("\n"),
    "utf-8",
  );
  writeFileSync(
    join(dir, "src", "game.js"),
    ["import { loadLevel } from './levels.js';", "const level = loadLevel();", "export class Game {", "  start() {", "    loadLevel();", "  }", "}"].join("\n"),
    "utf-8",
  );
  return dir;
}

test("code_find def: exact name first, then prefix matches", () => {
  const dir = fixture();
  try {
    const hits = findCode(dir, "loadLevel", { mode: "def" });
    assert.equal(hits[0]?.path, "src/levels.js");
    assert.equal(hits[0]?.line, 1);
    assert.equal(hits[0]?.rank, 1);
    // buildLevel starts with "build", loadLevel starts with "load" — neither is
    // an exact match for "loadLevel", so they rank below it if they match at all.
    assert.ok(hits.every((h) => h.name.includes("loadLevel") || h.name === "loadLevel"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code_find ref: call sites, not the declaration", () => {
  const dir = fixture();
  try {
    const hits = findCode(dir, "loadLevel", { mode: "ref" });
    const where = hits.map((h) => `${h.path}:${h.line}`);
    assert.ok(where.includes("src/game.js:1"), "the import is a reference");
    assert.ok(where.includes("src/game.js:2"));
    assert.ok(where.includes("src/game.js:5"));
    assert.ok(!where.includes("src/levels.js:1"), "the declaration itself is not a reference");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code_find text: substring, not a word", () => {
  const dir = fixture();
  try {
    const hits = findCode(dir, "buildLev", { mode: "text" });
    assert.equal(hits[0]?.path, "src/levels.js");
    assert.match(hits[0]?.snippet ?? "", /buildLevel/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code_find: the index notices a rewrite after invalidation", () => {
  const dir = fixture();
  try {
    assert.equal(findCode(dir, "newHelper", { mode: "def" }).length, 0);
    writeFileSync(join(dir, "src", "util.js"), "export function newHelper() {}\n", "utf-8");
    invalidateCodeIndex();
    const hits = findCode(dir, "newHelper", { mode: "def" });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.path, "src/util.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("code_find: no match says so, and an empty query is empty", () => {
  const dir = fixture();
  try {
    assert.deepEqual(findCode(dir, "   ", { mode: "def" }), []);
    assert.equal(renderFindHits(findCode(dir, "nothingHere", { mode: "def" }), "def"), "no definition found");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
