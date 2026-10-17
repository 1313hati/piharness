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

  lines.forEach((line, i) => {
    const lineNo = i + 1;
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
      if (m && m[1].length >= 2) push("method", m[2], lineNo);
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
        entry.symbols = outlineSource(source, rel).slice(0, opts.maxSymbolsPerFile ?? 6);
      } catch {
        // unreadable file: keep path only
      }
    }
    entries.push(entry);
    if (entries.length >= maxFiles) break;
  }
  return entries;
}

/** Render a repo map as compact text. */
export function renderRepoMap(entries: RepoMapEntry[]): string {
  return entries
    .map((e) => {
      const head = e.lines !== undefined ? `${e.path} (${e.lines} lines)` : e.path;
      if (e.symbols.length === 0) return head;
      const syms = e.symbols.map((s) => `${s.kind} ${s.name}@${s.line}`).join(", ");
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
