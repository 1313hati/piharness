/**
 * Built-in harness extensions: persistent todos, memory, web access, and code
 * navigation. Each contributes tools plus a per-turn context block.
 *
 * Everything here is plain TypeScript + typebox schemas; the Pi adapter turns
 * these into extension factories. No Pi import in this file.
 */

import { Type } from "typebox";
import { defineTool, clampText, type HarnessExtension, type HarnessTool } from "./types.js";
import {
  addTodo, clearDoneTodos, completeTodo, loadTodos, openTodos, removeTodo, reopenTodo, renderTodos, TodoError,
} from "./todo.js";
import {
  addFactToFile, globalMemoryPath, loadMemoryFile, memoryPath, removeFactFromFile, renderFacts, searchFacts,
} from "../context/memory.js";
import { fetchPage, searchWeb, WebError } from "./web.js";
import { buildRepoMap, outlineFile, renderRepoMap } from "./code.js";

export interface BuiltinDeps {
  cwd: string;
  /** Harness agent dir (holds global memory). */
  agentDir: string;
  fetchImpl?: typeof fetch;
}

export interface BuiltinResult {
  extensions: HarnessExtension[];
  /** Names of the tools registered, for logs/UI. */
  toolNames: string[];
}

function todoTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "todo",
    label: "Todo",
    description:
      "Read and update the persistent todo list for this project (it survives restarts). " +
      "Use it to plan multi-step work: add items first, mark each one done as you finish it. " +
      "actions: list (default), add, done, reopen, remove, clear_done.",
    promptSnippet: "todo — read/write the persistent task list (list, add, done, reopen, remove, clear_done)",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("list"), Type.Literal("add"), Type.Literal("done"),
        Type.Literal("reopen"), Type.Literal("remove"), Type.Literal("clear_done"),
      ], { description: "what to do with the list" }),
      text: Type.Optional(Type.String({ description: "todo text (add) or id/text of an existing todo (done/reopen/remove)" })),
      all: Type.Optional(Type.Boolean({ description: "list: include finished items too" })),
    }),
    async execute({ action, text, all }) {
      try {
        switch (action) {
          case "add": {
            if (!text) return { text: "todo add needs `text`.", isError: true };
            const item = addTodo(deps.cwd, text);
            return { text: `added ${item.id}: ${item.text}`, details: item };
          }
          case "done":
          case "reopen":
          case "remove": {
            if (!text) return { text: `todo ${action} needs \`text\` (id or part of the text).`, isError: true };
            const fn = action === "done" ? completeTodo : action === "reopen" ? reopenTodo : removeTodo;
            const item = fn(deps.cwd, text);
            if (!item) return { text: `no todo matches ${JSON.stringify(text)}; call todo list to see ids.`, isError: true };
            return { text: `${action}: ${item.id} ${item.text}`, details: item };
          }
          case "clear_done": {
            const n = clearDoneTodos(deps.cwd);
            return { text: `removed ${n} finished todo(s)` };
          }
          case "list":
          default: {
            const store = loadTodos(deps.cwd);
            const body = renderTodos(store, { includeDone: all, limit: 100 });
            return { text: body.length > 0 ? body : "todo list is empty" };
          }
        }
      } catch (e) {
        if (e instanceof TodoError) return { text: e.message, isError: true };
        throw e;
      }
    },
  });
}

function memoryTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "memory",
    label: "Memory",
    description:
      "Durable facts that survive restarts. scope=project (default) keeps facts in .harness/memory.json for this repo; " +
      "scope=global keeps them in the harness agent dir for every repo (use for user preferences and machine facts). " +
      "actions: remember, forget, recall, list. Remember only durable, verified facts, not guesses.",
    promptSnippet: "memory — persist verified facts across sessions (remember, forget, recall, list)",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("remember"), Type.Literal("forget"), Type.Literal("recall"), Type.Literal("list"),
      ], { description: "what to do" }),
      text: Type.Optional(Type.String({ description: "fact to remember, or id/text to forget" })),
      tags: Type.Optional(Type.Array(Type.String(), { description: "lowercase tags for recall" })),
      scope: Type.Optional(Type.Union([Type.Literal("project"), Type.Literal("global")], { description: "default: project" })),
      query: Type.Optional(Type.String({ description: "recall: words to match in fact text or tags" })),
    }),
    async execute({ action, text, tags, scope, query }) {
      const path = scope === "global" ? globalMemoryPath(deps.agentDir) : memoryPath(deps.cwd);
      const where = scope === "global" ? "global memory" : "project memory";
      try {
        switch (action) {
          case "remember": {
            if (!text) return { text: "memory remember needs `text`.", isError: true };
            const fact = addFactToFile(path, text, { tags, source: "user" });
            return { text: `remembered ${fact.id} (${where}): ${fact.fact}`, details: fact };
          }
          case "forget": {
            if (!text) return { text: "memory forget needs `text` (id or unique part of the fact).", isError: true };
            const removed = removeFactFromFile(path, text);
            if (!removed) return { text: `no unique match for ${JSON.stringify(text)} in ${where}.`, isError: true };
            return { text: `forgot ${removed.id}: ${removed.fact}`, details: removed };
          }
          case "recall": {
            const facts = searchFacts(loadMemoryFile(path), query ?? "");
            const body = renderFacts(facts, 20, 4_000);
            return { text: body.length > 0 ? body : `no matching facts in ${where}` };
          }
          case "list":
          default: {
            const body = renderFacts(loadMemoryFile(path).facts, 200, 8_000);
            return { text: body.length > 0 ? body : `${where} is empty` };
          }
        }
      } catch (e) {
        return { text: (e as Error).message, isError: true };
      }
    },
  });
}

function webSearchTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "web_search",
    label: "Web search",
    description:
      "Search the web. Use for current information, library documentation, error messages and version checks. " +
      "Returns titles, URLs and snippets; follow up with web_fetch on the few best URLs.",
    promptSnippet: "web_search — web search (DuckDuckGo, or SearXNG via PIHARNESS_SEARCH_URL)",
    parameters: Type.Object({
      query: Type.String({ description: "search query" }),
      max_results: Type.Optional(Type.Number({ description: "1-10, default 5" })),
    }),
    async execute({ query, max_results }) {
      try {
        const results = await searchWeb(query, { maxResults: max_results, fetchImpl: deps.fetchImpl });
        if (results.length === 0) return { text: "no results" };
        return {
          text: results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join("\n"),
          details: results,
        };
      } catch (e) {
        const msg = e instanceof WebError ? e.message : `search failed: ${(e as Error).message}`;
        return { text: msg, isError: true };
      }
    },
  });
}

function webFetchTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "web_fetch",
    label: "Web fetch",
    description:
      "Fetch a URL and return its readable text (HTML reduced to plain text). " +
      "Use after web_search to read the pages that matter, or for any documentation URL.",
    promptSnippet: "web_fetch — read a URL as clean text",
    parameters: Type.Object({
      url: Type.String({ description: "http(s) URL" }),
      max_chars: Type.Optional(Type.Number({ description: "default 12000" })),
    }),
    async execute({ url, max_chars }) {
      try {
        const page = await fetchPage(url, { maxChars: max_chars, fetchImpl: deps.fetchImpl });
        const head = page.title ? `# ${page.title}\n${page.url}\n\n` : `${page.url}\n\n`;
        return { text: clampText(head + page.text), details: { url: page.url, title: page.title } };
      } catch (e) {
        const msg = e instanceof WebError ? e.message : `fetch failed: ${(e as Error).message}`;
        return { text: msg, isError: true };
      }
    },
  });
}

function outlineTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "outline",
    label: "Outline",
    description:
      "List the symbols (functions, classes, types, methods, markdown headings) in one file with line numbers. " +
      "Cheaper than reading a large file when you only need its shape; then read the relevant line range.",
    promptSnippet: "outline — symbol list with line numbers for one file",
    parameters: Type.Object({
      path: Type.String({ description: "file path relative to the workspace root" }),
      filter: Type.Optional(Type.String({ description: "only symbols whose name contains this" })),
    }),
    async execute({ path, filter }) {
      try {
        const res = outlineFile(deps.cwd, path, filter);
        if (res.symbols.length === 0) return { text: `${res.path}: no symbols found (${res.lines} lines)` };
        return {
          text: `${res.path} (${res.lines} lines)\n` +
            res.symbols.map((s) => `${String(s.line).padStart(5)}  ${s.kind.padEnd(9)} ${s.name}`).join("\n"),
        };
      } catch (e) {
        return { text: `outline failed: ${(e as Error).message}`, isError: true };
      }
    },
  });
}

function repoMapTool(deps: BuiltinDeps): HarnessTool {
  return defineTool({
    name: "repo_map",
    label: "Repo map",
    description:
      "Bounded map of the workspace: files with their top symbols. Use at the start of an unfamiliar task to find where things live; " +
      "narrow with `subdir` in large repos.",
    promptSnippet: "repo_map — file tree with top symbols (bounded)",
    parameters: Type.Object({
      subdir: Type.Optional(Type.String({ description: "limit to a subdirectory" })),
      max_files: Type.Optional(Type.Number({ description: "default 80, max 400" })),
    }),
    async execute({ subdir, max_files }) {
      try {
        const entries = buildRepoMap(deps.cwd, { subdir, maxFiles: max_files });
        if (entries.length === 0) return { text: "no files found" };
        return { text: clampText(renderRepoMap(entries)), details: { files: entries.length } };
      } catch (e) {
        return { text: `repo_map failed: ${(e as Error).message}`, isError: true };
      }
    },
  });
}

/** Guidelines appended to the system prompt; kept short on purpose. */
export const CODING_GUIDELINES = [
  "Harness guidelines (coding):",
  "- Navigate before reading: repo_map for the layout, outline for a file's shape, grep for usages. Read only what you need.",
  "- Read a file before editing it; keep edits minimal and scoped to the request.",
  "- After code changes, run the project's own gates (typecheck/build/test) and report their real output. Never claim a test passed without running it.",
  "- Keep the todo list current for multi-step work: add items, mark them done as you finish.",
  "- Persist durable facts (commands, conventions, machine constraints) with memory; do not re-derive them next session.",
].join("\n");

/** Build the per-turn "harness state" block. Empty when there is nothing to say. */
export function renderHarnessContext(deps: BuiltinDeps): string {
  const parts: string[] = [];
  let todos: string;
  try {
    todos = renderTodos({ version: 1, items: openTodos(deps.cwd) }, { limit: 10 });
  } catch {
    todos = "";
  }
  if (todos) parts.push(`Open todos (persisted, .harness/todos.json):\n${todos}`);

  try {
    const project = renderFacts(loadMemoryFile(memoryPath(deps.cwd)).facts, 12, 900);
    if (project) parts.push(`Project memory (.harness/memory.json):\n${project}`);
  } catch {
    // corrupt memory is reported by the memory tool; don't break the prompt
  }
  try {
    const global = renderFacts(loadMemoryFile(globalMemoryPath(deps.agentDir)).facts, 8, 600);
    if (global) parts.push(`User memory (global):\n${global}`);
  } catch {
    // ignore
  }
  parts.push(CODING_GUIDELINES);
  return parts.join("\n\n");
}

/** All built-in extensions, in display order. */
export function createBuiltinExtensions(deps: BuiltinDeps): BuiltinResult {
  const todo = todoTool(deps);
  const memory = memoryTool(deps);
  const webSearch = webSearchTool(deps);
  const webFetch = webFetchTool(deps);
  const outline = outlineTool(deps);
  const repoMap = repoMapTool(deps);

  const extensions: HarnessExtension[] = [
    {
      name: "todos",
      description: "Persistent todo list that survives sessions (.harness/todos.json)",
      tools: [todo],
    },
    {
      name: "memory",
      description: "Project + global memory facts (remember/forget/recall/list)",
      tools: [memory],
    },
    {
      name: "web",
      description: "Web search and page reading (no API key required)",
      tools: [webSearch, webFetch],
    },
    {
      name: "code-nav",
      description: "Symbol outlines and bounded repo maps for navigation",
      tools: [outline, repoMap],
    },
  ];

  return { extensions, toolNames: extensions.flatMap((e) => e.tools.map((t) => t.name)) };
}
