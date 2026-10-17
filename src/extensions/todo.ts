/**
 * Persistent todo list for a workspace, stored at `<workspace>/.harness/todos.json`.
 *
 * The list deliberately outlives the session: a fresh `piharness` run in the
 * same repo starts with the previous todos injected into the system prompt, so
 * "pick up where I left off" works without re-explaining the state.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { atomicWriteJson } from "../fsutil.js";

export const TODO_SCHEMA_VERSION = 1;
export const MAX_TODOS = 200;
const MAX_TEXT = 500;

export type TodoStatus = "open" | "done";

export interface TodoItem {
  id: string;
  text: string;
  status: TodoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TodoStore {
  version: 1;
  items: TodoItem[];
}

export class TodoError extends Error {}

export function todosPath(workspace: string): string {
  return join(workspace, ".harness", "todos.json");
}

function emptyStore(): TodoStore {
  return { version: TODO_SCHEMA_VERSION, items: [] };
}

function validate(raw: unknown, path: string): TodoStore {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new TodoError(`${path} must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;
  if (obj.version !== TODO_SCHEMA_VERSION) {
    throw new TodoError(`${path} version must be ${TODO_SCHEMA_VERSION}, got ${JSON.stringify(obj.version)}`);
  }
  if (!Array.isArray(obj.items)) throw new TodoError(`${path} must have an items array`);
  for (const item of obj.items) {
    if (typeof item !== "object" || item === null) throw new TodoError(`${path}: each todo must be an object`);
    const t = item as Record<string, unknown>;
    if (typeof t.id !== "string" || typeof t.text !== "string" || t.text.length === 0) {
      throw new TodoError(`${path}: each todo needs a string id and non-empty text`);
    }
    if (t.status !== "open" && t.status !== "done") {
      throw new TodoError(`${path}: todo ${t.id} status must be "open" or "done"`);
    }
  }
  const store = raw as TodoStore;
  for (const t of store.items) {
    if (typeof t.createdAt !== "string") t.createdAt = new Date(0).toISOString();
    if (typeof t.updatedAt !== "string") t.updatedAt = t.createdAt;
  }
  return store;
}

export function loadTodos(workspace: string): TodoStore {
  const path = todosPath(workspace);
  if (!existsSync(path)) return emptyStore();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    throw new TodoError(`${path} has corrupt JSON: ${String(e)}; fix or delete it.`);
  }
  return validate(raw, path);
}

export function saveTodos(workspace: string, store: TodoStore): void {
  atomicWriteJson(todosPath(workspace), store);
}

export function openTodos(workspace: string): TodoItem[] {
  return loadTodos(workspace).items.filter((t) => t.status === "open");
}

/** Add an open todo. Refuses duplicates of an existing open item. */
export function addTodo(workspace: string, text: string): TodoItem {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new TodoError("todo text must be non-empty");
  if (trimmed.length > MAX_TEXT) throw new TodoError(`todo text is longer than ${MAX_TEXT} characters`);
  const store = loadTodos(workspace);
  const existing = store.items.find((t) => t.status === "open" && t.text.toLowerCase() === trimmed.toLowerCase());
  if (existing) return existing;
  if (store.items.length >= MAX_TODOS) throw new TodoError(`todo list holds the max of ${MAX_TODOS} items`);
  const now = new Date().toISOString();
  const item: TodoItem = {
    // Random first so short id prefixes stay unambiguous across quick adds.
    id: `t${randomUUID().slice(0, 5)}`,
    text: trimmed,
    status: "open",
    createdAt: now,
    updatedAt: now,
  };
  store.items.push(item);
  saveTodos(workspace, store);
  return item;
}

/** Find a todo by full id, unique id prefix, or unique text substring. */
export function findTodo(store: TodoStore, idOrText: string): TodoItem | undefined {
  const needle = idOrText.trim().toLowerCase();
  if (needle.length === 0) return undefined;
  const byId = store.items.find((t) => t.id.toLowerCase() === needle);
  if (byId) return byId;
  const prefixed = store.items.filter((t) => t.id.toLowerCase().startsWith(needle));
  if (prefixed.length === 1) return prefixed[0];
  const byText = store.items.filter((t) => t.text.toLowerCase().includes(needle));
  if (byText.length === 1) return byText[0];
  return undefined;
}

export function completeTodo(workspace: string, idOrText: string): TodoItem | undefined {
  const store = loadTodos(workspace);
  const item = findTodo(store, idOrText);
  if (!item) return undefined;
  item.status = "done";
  item.updatedAt = new Date().toISOString();
  saveTodos(workspace, store);
  return item;
}

export function reopenTodo(workspace: string, idOrText: string): TodoItem | undefined {
  const store = loadTodos(workspace);
  const item = findTodo(store, idOrText);
  if (!item) return undefined;
  item.status = "open";
  item.updatedAt = new Date().toISOString();
  saveTodos(workspace, store);
  return item;
}

export function removeTodo(workspace: string, idOrText: string): TodoItem | undefined {
  const store = loadTodos(workspace);
  const item = findTodo(store, idOrText);
  if (!item) return undefined;
  store.items = store.items.filter((t) => t.id !== item.id);
  saveTodos(workspace, store);
  return item;
}

/** Drop finished items; returns how many were removed. */
export function clearDoneTodos(workspace: string): number {
  const store = loadTodos(workspace);
  const before = store.items.length;
  store.items = store.items.filter((t) => t.status === "open");
  if (store.items.length !== before) saveTodos(workspace, store);
  return before - store.items.length;
}

/** Render the list as `- [ ] text (id)` lines; done items are omitted unless asked. */
export function renderTodos(store: TodoStore, opts: { includeDone?: boolean; limit?: number } = {}): string {
  const items = store.items.filter((t) => opts.includeDone || t.status === "open");
  if (items.length === 0) return "";
  return items
    .slice(0, opts.limit ?? 50)
    .map((t) => `- [${t.status === "done" ? "x" : " "}] ${t.text} (${t.id})`)
    .join("\n");
}
