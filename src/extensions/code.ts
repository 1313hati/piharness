/**
 * Code navigation without an LSP: symbol outlines and a bounded repo map.
 *
 * Regex-based on purpose — it works for every file in a repo with zero setup,
 * costs microseconds, and never blocks on a language server. It answers
 * "where is this defined / what is in this file", while `grep` answers "where
 * is this used". Together they cover most navigation a coding agent needs.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve } from "node:path";

export interface SymbolInfo {
  kind: string;
  name: string;
  line: number;
}

const CODE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".rb", ".java", ".kt",
  ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".php", ".swift", ".scala", ".sh", ".sql", ".lua",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", ".nuxt", "vendor", "target",
  ".venv", "venv", "__pycache__", "coverage", ".harness", ".cache", ".turbo", ".idea", ".vscode",
]);

const MAX_SCAN_ENTRIES = 4_000;

/** Extract top-level-ish symbols with 1-based line numbers. */
export function outlineSource(source: string, filename: string): SymbolInfo[] {
  const ext = extname(filename).toLowerCase();
  const lines = source.split("\n");
  const out: SymbolInfo[] = [];
  const push = (kind: string, name: string, line: number) => {
    if (name && out.length < 400) out.push({ kind, name, line });
  };

  // Language-specific declaration patterns. Class methods are matched by
  // indentation so nested blocks do not flood the outline.
  const tsPatterns: Array<[RegExp, string]> = [
    [/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/, "function"],
    [/^\s*(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
    [/^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
    [/^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, "type"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/, "const fn"],
    [/^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/, "const"],
    [/^\s*(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  ];
  const methodRe = /^(\s{2,})(?:(?:public|private|protected|static|async|readonly|override)\s+)*([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{]+)?\{\s*$/;

  const pyPatterns: Array<[RegExp, string]> = [
    [/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, "function"],
    [/^\s*class\s+([A-Za-z_]\w*)/, "class"],
  ];
  const rustPatterns: Array<[RegExp, string]> = [
    [/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_]\w*)/, "fn"],
    [/^\s*(?:pub\s+)?struct\s+([A-Za-z_]\w*)/, "struct"],
    [/^\s*(?:pub\s+)?enum\s+([A-Za-z_]\w*)/, "enum"],
    [/^\s*(?:pub\s+)?trait\s+([A-Za-z_]\w*)/, "trait"],
    [/^\s*impl(?:<[^>]*>)?\s+(?:[\w:<>]+\s+for\s+)?([A-Za-z_]\w*)/, "impl"],
  ];
  const goPatterns: Array<[RegExp, string]> = [
    [/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/, "func"],
    [/^\s*type\s+([A-Za-z_]\w*)\s+(?:struct|interface)/, "type"],
  ];

  let isJsLike = false;
  let patterns: Array<[RegExp, string]> = tsPatterns;
  if ([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].includes(ext)) {
    isJsLike = true;
  } else if (ext === ".py") {
    patterns = pyPatterns;
  } else if (ext === ".rs") {
    patterns = rustPatterns;
  } else if (ext === ".go") {
    patterns = goPatterns;
  } else if (ext === ".md" || ext === ".mdx") {
    patterns = [[/^(#{1,4})\s+(.+?)\s*$/, "heading"]];
  } else {
    patterns = [];
  }

  // A method is only a method inside a class body. Without that check the
  // permissive `name(...) {` pattern reports `if (...) {` and `for (...) {` as
  // methods, and a map full of `method if@42` teaches the reader to ignore it.
  const JS_KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "else", "do", "try", "finally",
    "function", "catch", "with", "typeof", "new", "await", "yield", "case", "default",
  ]);
  let braceDepth = 0;
  let classDepth: number | null = null;

  lines.forEach((line, i) => {
    const lineNo = i + 1;
    const opens = (line.match(/\{/g) ?? []).length;
    const closes = (line.match(/\}/g) ?? []).length;
    const depthBefore = braceDepth;
    if (/\bclass\s+[A-Za-z_]\w*/.test(line)) classDepth = depthBefore;
    braceDepth = Math.max(0, braceDepth + opens - closes);
    if (classDepth !== null && braceDepth <= classDepth && closes > 0 && opens === 0) classDepth = null;
    if (ext === ".md" || ext === ".mdx") {
      const m = /^(#{1,4})\s+(.+?)\s*$/.exec(line);
      if (m) push(`h${m[1].length}`, m[2], lineNo);
      return;
    }
    if (/^\s*(\/\/|#|\*|\/\*)/.test(line)) return; // comments
    for (const [re, kind] of patterns) {
      const m = re.exec(line);
      if (m) {
        if (kind === "heading") push(kind, m[2], lineNo);
        else push(kind, m[1], lineNo);
        return;
      }
    }
    if (isJsLike) {
      const m = methodRe.exec(line);
      if (m && m[1].length >= 2 && classDepth !== null && depthBefore === classDepth + 1) {
        if (!JS_KEYWORDS.has(m[2])) push("method", m[2], lineNo);
      }
    }
  });
  return out;
}

export interface RepoMapOptions {
  maxFiles?: number;
  maxSymbolsPerFile?: number;
  maxDepth?: number;
  subdir?: string;
}

export interface RepoMapEntry {
  path: string;
  symbols: SymbolInfo[];
  lines?: number;
}

function walk(root: string, dir: string, depth: number, maxDepth: number, out: string[], budget: { n: number }): void {
  if (depth > maxDepth || budget.n <= 0) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  entries.sort();
  for (const name of entries) {
    if (budget.n <= 0) return;
    if (name.startsWith(".") && name !== ".github") continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      if (IGNORED_DIRS.has(name)) continue;
      walk(root, full, depth + 1, maxDepth, out, budget);
    } else if (st.isFile()) {
      if (st.size > 512 * 1024) continue;
      out.push(relative(root, full));
      budget.n -= 1;
    }
  }
}

/** Bounded map of the repo: relative paths plus a few top symbols per file. */
export function buildRepoMap(cwd: string, opts: RepoMapOptions = {}): RepoMapEntry[] {
  const root = resolve(cwd);
  const subdir = opts.subdir ? resolve(root, opts.subdir) : root;
  if (!subdir.startsWith(root)) throw new Error(`${opts.subdir} is outside the workspace`);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 80, 1), 400);
  const files: string[] = [];
  walk(root, subdir, 0, opts.maxDepth ?? 6, files, { n: MAX_SCAN_ENTRIES });

  const entries: RepoMapEntry[] = [];
  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    const entry: RepoMapEntry = { path: rel, symbols: [] };
    if (CODE_EXT.has(ext) || ext === ".md") {
      try {
        const source = readFileSync(join(root, rel), "utf-8");
        entry.lines = source.split("\n").length;
        // Keep the full outline: the kind filter and the per-file cap belong at
        // render time, otherwise six leading `const`s hide every function.
        entry.symbols = outlineSource(source, rel).slice(0, 200);
      } catch {
        // unreadable file: keep path only
      }
    }
    entries.push(entry);
    if (entries.length >= maxFiles) break;
  }
  // A map is only useful if the substantive files come first: a scratch script
  // with four `const` lines must not push the engine out of the budget.
  const score = (e: RepoMapEntry) =>
    e.symbols.reduce((n, s) => n + (s.kind === "const" || s.kind === "variable" ? 0.25 : 1), 0);
  return entries.sort((a, b) => score(b) - score(a) || a.path.localeCompare(b.path));
}

/** Render a repo map as compact text. */
export function renderRepoMap(entries: RepoMapEntry[]): string {
  return entries
    .map((e) => {
      const head = e.lines !== undefined ? `${e.path} (${e.lines} lines)` : e.path;
      if (e.symbols.length === 0) return head;
      // Declarations carry the shape of a file; top-level constants are mostly
      // configuration noise, so they are only shown when nothing else exists.
      const meaningful = e.symbols.filter((s) => s.kind !== "const" && s.kind !== "variable");
      const shown = (meaningful.length > 0 ? meaningful : e.symbols).slice(0, e.symbols.length > 0 ? 6 : 0);
      const syms = shown.map((s) => `${s.kind} ${s.name}@${s.line}`).join(", ");
      return `${head}\n    ${syms}`;
    })
    .join("\n");
}

/** Read a file and return an outline, optionally filtered by symbol name. */
export function outlineFile(cwd: string, relPath: string, filter?: string): { path: string; symbols: SymbolInfo[]; lines: number } {
  const root = resolve(cwd);
  const full = resolve(root, relPath);
  if (!full.startsWith(root)) throw new Error(`${relPath} is outside the workspace`);
  const source = readFileSync(full, "utf-8");
  let symbols = outlineSource(source, full);
  if (filter) {
    const f = filter.toLowerCase();
    symbols = symbols.filter((s) => s.name.toLowerCase().includes(f));
  }
  return { path: relative(root, full), symbols, lines: source.split("\n").length };
}

// ─── Locate: definitions and references ──────────────────────────────────────

export type FindMode = "def" | "ref" | "text";

export interface FindHit {
  path: string;
  line: number;
  kind: string;
  name: string;
  /** 1 for an exact name, 2 for a prefix, 3 for a substring. */
  rank: number;
  /** Trimmed source line, for `ref` and `text` hits. */
  snippet?: string;
}

export interface FindOptions {
  mode?: FindMode;
  /** Limit the scan to a subdirectory (relative to the workspace). */
  subdir?: string;
  limit?: number;
  maxFiles?: number;
}

interface IndexedFile {
  path: string;
  symbols: SymbolInfo[];
}

interface CacheEntry {
  at: number;
  files: IndexedFile[];
}

const CACHE_TTL_MS = 3_000;
const cache = new Map<string, CacheEntry>();

function indexOf(root: string, subdir: string | undefined, maxFiles: number): IndexedFile[] {
  const key = `${root}::${subdir ?? ""}::${maxFiles}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.files;

  const paths: string[] = [];
  walk(root, subdir ? resolve(root, subdir) : root, 0, 8, paths, { n: MAX_SCAN_ENTRIES });
  const files: IndexedFile[] = [];
  for (const rel of paths) {
    if (!CODE_EXT.has(extname(rel).toLowerCase())) continue;
    try {
      const source = readFileSync(join(root, rel), "utf-8");
      files.push({ path: rel, symbols: outlineSource(source, rel) });
    } catch {
      // unreadable: skip
    }
    if (files.length >= maxFiles) break;
  }
  cache.set(key, { at: Date.now(), files });
  return files;
}

/** Forget the index; called when a file tool reports a write. */
export function invalidateCodeIndex(): void {
  cache.clear();
}

/**
 * Find where a name is defined or used. Cheap enough to call before reading
 * anything: it answers "which file, which line" without an LSP.
 */
export function findCode(cwd: string, query: string, opts: FindOptions = {}): FindHit[] {
  const root = resolve(cwd);
  const mode = opts.mode ?? "def";
  const needle = query.trim();
  if (!needle) return [];
  const limit = Math.min(Math.max(opts.limit ?? 40, 1), 200);
  const maxFiles = Math.min(Math.max(opts.maxFiles ?? 400, 1), MAX_SCAN_ENTRIES);

  if (mode === "def") {
    const files = indexOf(root, opts.subdir, maxFiles);
    const hits: FindHit[] = [];
    for (const file of files) {
      for (const sym of file.symbols) {
        if (sym.name === needle) hits.push({ path: file.path, line: sym.line, kind: sym.kind, name: sym.name, rank: 1 });
        else if (sym.name.startsWith(needle)) hits.push({ path: file.path, line: sym.line, kind: sym.kind, name: sym.name, rank: 2 });
        else if (sym.name.toLowerCase().includes(needle.toLowerCase())) hits.push({ path: file.path, line: sym.line, kind: sym.kind, name: sym.name, rank: 3 });
      }
    }
    return hits.sort((a, b) => a.rank - b.rank || a.path.localeCompare(b.path) || a.line - b.line).slice(0, limit);
  }

  // ref/text: search the text of candidate files, skipping the definition of
  // an exact symbol in `ref` mode (a caller and a declaration are different
  // answers, and mixing them is how "who calls this" turns into noise).
  const files = indexOf(root, opts.subdir, maxFiles);
  const word = new RegExp(`\\b${needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
  const hits: FindHit[] = [];
  for (const file of files) {
    let source: string;
    try {
      source = readFileSync(join(root, file.path), "utf-8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    const defLines = new Set(file.symbols.filter((s) => s.name === needle).map((s) => s.line));
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const matched = mode === "ref" ? word.test(line) : line.includes(needle);
      if (!matched) continue;
      if (mode === "ref" && defLines.has(i + 1)) continue;
      const trimmed = line.trim();
      const comment = /^(\/\/|\/\*|\*|#|--|;;)/.test(trimmed);
      hits.push({
        path: file.path,
        line: i + 1,
        kind: comment ? "comment" : "use",
        name: needle,
        rank: comment ? 3 : 1,
        snippet: trimmed.slice(0, 140),
      });
      if (hits.length >= limit * 4) break;
    }
    if (hits.length >= limit * 4) break;
  }
  // Code first; a mention inside a comment explains intent but is not a call
  // site, and burying three real callers under a docstring is how navigation
  // stops saving time.
  return hits.sort((a, b) => a.rank - b.rank).slice(0, limit);
}

/** Render find hits compactly: `path:line  kind name  — snippet`. */
export function renderFindHits(hits: FindHit[], mode: FindMode): string {
  if (hits.length === 0) return mode === "def" ? "no definition found" : "no matches found";
  return hits
    .map((h) => {
      const where = `${h.path}:${h.line}`;
      const head = mode === "def" ? `${where}  ${h.kind} ${h.name}` : `${where}  ${h.snippet ?? ""}`;
      return head.trimEnd();
    })
    .join("\n");
}
