import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  addTodo, clearDoneTodos, completeTodo, findTodo, loadTodos, openTodos, removeTodo,
  renderTodos, reopenTodo, todosPath, TodoError,
} from "../src/extensions/todo.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "piharness-todo-"));
}

test("todo: add, dedupe, complete, persist across a fresh load", () => {
  const root = scratch();
  try {
    const a = addTodo(root, "write the parser");
    const b = addTodo(root, "write the parser");
    assert.equal(a.id, b.id, "same text while open returns the existing item");

    addTodo(root, "add tests");
    assert.equal(openTodos(root).length, 2);

    const done = completeTodo(root, a.id);
    assert.equal(done?.status, "done");

    // A new process would call loadTodos again; the file is the session boundary.
    const fresh = loadTodos(root);
    assert.equal(fresh.items.length, 2);
    assert.equal(fresh.items.filter((t) => t.status === "open").length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("todo: find by unique id prefix and by unique text substring", () => {
  const root = scratch();
  try {
    const item = addTodo(root, "refactor the session adapter");
    addTodo(root, "unrelated thing for the map");
    const store = loadTodos(root);

    assert.equal(findTodo(store, item.id.slice(0, 6))?.id, item.id);
    assert.equal(findTodo(store, "session adapter")?.id, item.id);
    assert.equal(findTodo(store, "nope"), undefined);
    // ambiguous text matches nothing rather than guessing
    assert.equal(findTodo(store, "the"), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("todo: reopen, remove, clear_done, and empty rendering", () => {
  const root = scratch();
  try {
    assert.equal(renderTodos(loadTodos(root)), "");

    const a = addTodo(root, "a");
    const b = addTodo(root, "b");
    completeTodo(root, a.id);
    assert.equal(renderTodos(loadTodos(root)), `- [ ] b (${b.id})`);
    assert.match(renderTodos(loadTodos(root), { includeDone: true }), /- \[x\] a/);

    reopenTodo(root, a.id);
    assert.equal(openTodos(root).length, 2);

    completeTodo(root, b.id);
    assert.equal(clearDoneTodos(root), 1);
    assert.equal(loadTodos(root).items.length, 1);

    assert.equal(removeTodo(root, a.id)?.id, a.id);
    assert.equal(loadTodos(root).items.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("todo: rejects empty text and surfaces corrupt files", () => {
  const root = scratch();
  try {
    assert.throws(() => addTodo(root, "   "), TodoError);
    mkdirSync(join(root, ".harness"), { recursive: true });
    writeFileSync(todosPath(root), "{not json");
    assert.throws(() => loadTodos(root), TodoError);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
