/**
 * M3 context service: memory store, skill discovery, relevance selection,
 * and context block rendering. No model, no network.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadMemory,
  saveMemory,
  addFact,
  removeFact,
  MemoryError,
  listSkills,
  selectContext,
  estimateTokens,
  goalTokens,
  renderSelection,
  buildContextBlock,
} from "../src/context/index.ts";
import type { Memory } from "../src/context/index.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "piharness-ctx-"));
}

// ─── Memory store ──────────────────────────────────────────────────────────────

test("memory: add / list / remove round-trip", () => {
  const ws = tmp();
  try {
    assert.deepEqual(loadMemory(ws), { version: 1, facts: [] });
    const f1 = addFact(ws, "The build uses npm test as its only gate.", { tags: ["build", "tests"] });
    const f2 = addFact(ws, "Local model qwen38 runs at 127.0.0.1:8080/v1.", { source: "verified" });
    const mem = loadMemory(ws);
    assert.equal(mem.facts.length, 2);
    assert.equal(mem.facts[0].id, f1.id);
    assert.deepEqual(f1.tags, ["build", "tests"]);
    assert.equal(f2.source, "verified");
    assert.ok(removeFact(ws, f2.id));
    assert.equal(loadMemory(ws).facts.length, 1);
    assert.ok(!removeFact(ws, f2.id));
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("memory: corrupt file raises MemoryError, not silent ignore", () => {
  const ws = tmp();
  try {
    const dir = join(ws, ".harness");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "memory.json"), "{ not json");
    assert.throws(() => loadMemory(ws), MemoryError);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("memory: bad schema (wrong version / missing fact field) raises MemoryError", () => {
  const ws = tmp();
  try {
    const mem = loadMemory(ws);
    (mem as Memory & { version: number }).version = 99;
    saveMemory(ws, mem as unknown as Memory);
    assert.throws(() => loadMemory(ws), MemoryError);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("memory: empty fact rejected", () => {
  const ws = tmp();
  try {
    assert.throws(() => addFact(ws, "   "), MemoryError);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── Skill discovery ───────────────────────────────────────────────────────────

function writeSkill(ws: string, name: string, body: string): void {
  const dir = join(ws, ".harness", "skills", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

test("skills: parsed title + description; missing dir → empty", () => {
  const ws = tmp();
  try {
    assert.deepEqual(listSkills(ws), []);
    writeSkill(
      ws,
      "npm-gates",
      "# NPM gates\nRun npm run typecheck, npm run build, then npm test after any change.\n\n## Steps\n1. typecheck\n2. build\n3. test\n",
    );
    const skills = listSkills(ws);
    assert.equal(skills.length, 1);
    assert.equal(skills[0].name, "npm-gates");
    assert.equal(skills[0].title, "NPM gates");
    assert.match(skills[0].description, /^Run npm run typecheck/);
    assert.match(skills[0].body, /## Steps/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

test("skills: unreadable or malformed SKILL.md does not crash listing", () => {
  const ws = tmp();
  try {
    const dir = join(ws, ".harness", "skills", "no-skillmd");
    mkdirSync(dir, { recursive: true }); // directory without SKILL.md
    writeSkill(ws, "empty", "");
    const skills = listSkills(ws);
    assert.deepEqual(
      skills.map((s) => s.name),
      ["empty"],
    );
    assert.equal(skills[0].title, "empty"); // falls back to dir name
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});

// ─── Selection ─────────────────────────────────────────────────────────────────

function memWith(facts: Array<{ fact: string; tags?: string[] }>): Memory {
  const base = Date.parse("2026-01-01T00:00:00Z");
  return {
    version: 1,
    facts: facts.map((f, i) => ({
      id: `f${i}`,
      fact: f.fact,
      tags: f.tags ?? [],
      source: "user",
      createdAt: new Date(base + i * 1000).toISOString(),
    })),
  };
}

test("selection: matched facts rank first; unmatched excluded when a match exists", () => {
  const memory = memWith([
    { fact: "Deploy goes to a staging box over ssh.", tags: ["deploy"] },
    { fact: "All tests run via npm test and must pass before push.", tags: ["tests"] },
  ]);
  const sel = selectContext("fix the failing tests", memory, []);
  assert.equal(sel.facts.length, 1);
  assert.match(sel.facts[0].fact.fact, /npm test/);
  assert.ok(sel.facts[0].score > 0);
  assert.equal(sel.facts[0].fallback, false);
});

test("selection: no match → at most 3 most-recent facts as fallback notes", () => {
  const memory = memWith([
    { fact: "fact one about deployment" },
    { fact: "fact two about billing" },
    { fact: "fact three about the database" },
    { fact: "fact four about networking" },
  ]);
  const sel = selectContext("zzz qqq nothing matches here", memory, []);
  assert.equal(sel.facts.length, 3);
  assert.ok(sel.facts.every((f) => f.fallback));
  // most recent first
  assert.match(sel.facts[0].fact.fact, /fact four/);
});

test("selection: skills only when matched, capped at 3", () => {
  const mk = (name: string, desc: string) => ({
    name,
    title: `${name} build`,
    description: desc,
    body: "steps",
    path: `/${name}`,
  });
  const skills = [
    mk("a", "first"),
    mk("b", "second"),
    mk("c", "third"),
    mk("d", "fourth"),
    mk("e", "write documentation pages"),
  ];
  const sel = selectContext("build the thing", { version: 1, facts: [] }, skills);
  // four skills match "build"; only three allowed, and the unrelated one never appears
  assert.equal(sel.skills.length, 3);
  assert.ok(sel.skills.every((s) => s.skill.title.includes("build")));
  assert.ok(!sel.skills.some((s) => s.skill.name === "e"));
});

test("selection: skill body budget truncates oversized skills", () => {
  const skills = [
    { name: "big1", title: "Big build", description: "first big build procedure", body: "x".repeat(7200), path: "/b1" },
    { name: "big2", title: "Big build two", description: "second big build procedure", body: "y".repeat(8000), path: "/b2" },
    { name: "tiny", title: "Tiny build", description: "small build helper", body: "z".repeat(100), path: "/t" },
  ];
  const sel = selectContext("build now", { version: 1, facts: [] }, skills, { skillTokens: 2000 });
  // big1 costs 1800 tokens; big2 (2000) does not fit after it; tiny (25) still does
  assert.deepEqual(sel.skills.map((s) => s.skill.name), ["big1", "tiny"]);
  assert.ok(sel.skillTokens <= 2000);
});

test("selection: goalTokens ignores short words; estimateTokens is ~4 chars/token", () => {
  assert.deepEqual([...goalTokens("Fix the broken tests!")].sort(), ["broken", "fix", "tests", "the"]);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens(""), 0);
});

// ─── Rendering ─────────────────────────────────────────────────────────────────

test("render: empty selection → empty string (nothing injected)", () => {
  assert.equal(renderSelection("do the thing", { version: 1, facts: [] }, []), "");
});

test("render: facts section with tags, skills section with body", () => {
  const memory = memWith([{ fact: "Use pnpm, not npm, in this repo.", tags: ["tools"] }]);
  const skills = [
    { name: "gates", title: "Gate order", description: "run the gate commands in order", body: "# Gate order\n1. typecheck\n2. test", path: "/g" },
  ];
  const block = renderSelection("run pnpm gate order", memory, skills);
  assert.match(block, /Project notes \(verified facts, from \.harness\/memory\.json\):/);
  assert.match(block, /- Use pnpm, not npm, in this repo\. \[tools\]/);
  assert.match(block, /### gates: Gate order/);
  assert.match(block, /1\. typecheck/);
});

test("buildContextBlock end-to-end in a workspace", () => {
  const ws = tmp();
  try {
    assert.equal(buildContextBlock(ws, "anything"), "");
    addFact(ws, "Releases go out via npm publish from main.", { tags: ["release"] });
    writeSkill(ws, "release", "# Release\nCheck the tag, then publish.");
    const block = buildContextBlock(ws, "prepare the next release");
    assert.match(block, /npm publish/);
    assert.match(block, /### release: Release/);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
});
