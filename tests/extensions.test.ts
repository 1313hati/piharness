import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CODING_GUIDELINES, createBuiltinExtensions, renderHarnessContext } from "../src/extensions/builtin.js";
import { addTodo } from "../src/extensions/todo.js";
import { addFact, addFactToFile, globalMemoryPath, loadMemoryFile, memoryPath, removeFactFromFile, renderFacts, searchFacts } from "../src/context/memory.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "piharness-ext-"));
}

test("extensions: built-ins expose the documented tools exactly once", () => {
  const root = scratch();
  try {
    const built = createBuiltinExtensions({ cwd: root, agentDir: join(root, "agent") });
    assert.deepEqual(built.toolNames, ["todo", "memory", "web_search", "web_fetch", "outline", "repo_map", "code_find"]);
    assert.equal(new Set(built.toolNames).size, built.toolNames.length);
    assert.deepEqual(built.extensions.map((e) => e.name), ["todos", "memory", "web", "code-nav"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensions: context block carries todos, both memory scopes and guidelines", () => {
  const root = scratch();
  const agentDir = join(root, "agent");
  try {
    addTodo(root, "finish the todo tool");
    addFact(root, "tests run with tsx --test", { tags: ["testing"] });
    addFactToFile(globalMemoryPath(agentDir), "user prefers tabs over spaces", { source: "user" });

    const block = renderHarnessContext({ cwd: root, agentDir });
    assert.match(block, /Open todos/);
    assert.match(block, /finish the todo tool/);
    assert.match(block, /Project memory/);
    assert.match(block, /tsx --test/);
    assert.match(block, /User memory/);
    assert.match(block, /prefers tabs/);
    assert.ok(block.includes(CODING_GUIDELINES), "guidelines are appended");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensions: context block is empty-ish but valid with no state", () => {
  const root = scratch();
  try {
    const block = renderHarnessContext({ cwd: root, agentDir: join(root, "agent") });
    assert.doesNotMatch(block, /Open todos/);
    assert.match(block, /Harness guidelines/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("extensions: corrupt memory never breaks the prompt", () => {
  const root = scratch();
  try {
    mkdirSync(join(root, ".harness"), { recursive: true });
    writeFileSync(memoryPath(root), "{oops");
    const block = renderHarnessContext({ cwd: root, agentDir: join(root, "agent") });
    assert.match(block, /Harness guidelines/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: global scope, substring forget and search", () => {
  const root = scratch();
  const agentDir = join(root, "agent");
  try {
    const path = globalMemoryPath(agentDir);
    addFactToFile(path, "the CI runs on arm64", { tags: ["ci"] });
    addFactToFile(path, "deploys go through the release branch");

    const facts = loadMemoryFile(path).facts;
    assert.equal(facts.length, 2);
    assert.equal(searchFacts(loadMemoryFile(path), "arm64").length, 1);
    assert.equal(searchFacts(loadMemoryFile(path), "ci").length, 1);

    const removed = removeFactFromFile(path, "arm64");
    assert.equal(removed?.fact, "the CI runs on arm64");
    assert.equal(loadMemoryFile(path).facts.length, 1);

    // ambiguous substring ("the" is in both facts) removes nothing
    addFactToFile(path, "the deploy branch is protected");
    assert.equal(removeFactFromFile(path, "the"), undefined);
    assert.equal(loadMemoryFile(path).facts.length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("memory: renderFacts caps lines by count and by characters", () => {
  const facts = Array.from({ length: 30 }, (_, i) => ({
    id: `f${i}`,
    fact: `fact number ${i}`,
    tags: [],
    source: "user" as const,
    createdAt: new Date(0).toISOString(),
  }));
  assert.equal(renderFacts(facts, 5).split("\n").length, 5);
  const capped = renderFacts(facts, 30, 50);
  assert.ok(capped.length <= 60, `capped length ${capped.length}`);
  assert.match(capped, /^- fact number/);
});
