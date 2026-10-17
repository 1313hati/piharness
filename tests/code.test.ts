import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRepoMap, outlineFile, outlineSource, renderRepoMap } from "../src/extensions/code.js";

const TS_SRC = `import { x } from "./x.js";

// a comment with function fake() {}
export interface Config {
  a: string;
}

export type Level = "low" | "high";

export async function loadConfig(path: string): Promise<Config> {
  return JSON.parse(path);
}

export const version = "1.0";

export class Session {
  private ready = false;

  async start(): Promise<void> {
    this.ready = true;
  }
}
`;

test("code: outline finds exported symbols with line numbers", () => {
  const symbols = outlineSource(TS_SRC, "src/session.ts");
  const names = symbols.map((s) => `${s.kind} ${s.name}`);
  assert.ok(names.includes("interface Config"));
  assert.ok(names.includes("type Level"));
  assert.ok(names.includes("function loadConfig"));
  assert.ok(names.includes("const version"));
  assert.ok(names.includes("class Session"));
  assert.ok(names.includes("method start"));
  assert.ok(!names.some((n) => n.includes("fake")), "commented-out code is ignored");

  const load = symbols.find((s) => s.name === "loadConfig")!;
  assert.equal(load.line, 10);
});

test("code: python, rust, go and markdown outlines", () => {
  assert.deepEqual(
    outlineSource("class A:\n    pass\n\ndef go(x):\n    return x\n", "a.py").map((s) => `${s.kind} ${s.name}`),
    ["class A", "function go"],
  );
  assert.deepEqual(
    outlineSource("pub struct S;\nimpl S {\n  pub fn new() {}\n}\n", "a.rs").map((s) => `${s.kind} ${s.name}`),
    ["struct S", "impl S", "fn new"],
  );
  assert.deepEqual(
    outlineSource("func main() {}\ntype T struct{}\n", "a.go").map((s) => `${s.kind} ${s.name}`),
    ["func main", "type T"],
  );
  assert.deepEqual(
    outlineSource("# Title\n\ntext\n\n## Part\n", "README.md").map((s) => `${s.kind} ${s.name}`),
    ["h1 Title", "h2 Part"],
  );
});

test("code: repo map skips junk dirs, honors limits, renders paths", () => {
  const root = mkdtempSync(join(tmpdir(), "piharness-map-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(root, "src", "a.ts"), "export function hello() {}\n");
    writeFileSync(join(root, "README.md"), "# Doc\n");
    writeFileSync(join(root, "node_modules", "pkg", "index.js"), "module.exports = 1\n");

    const entries = buildRepoMap(root);
    const paths = entries.map((e) => e.path);
    assert.ok(paths.includes("src/a.ts"));
    assert.ok(paths.includes("README.md"));
    assert.ok(!paths.some((p) => p.includes("node_modules")));

    const mapped = renderRepoMap(entries);
    assert.match(mapped, /src\/a\.ts \(2 lines\)/);
    assert.match(mapped, /function hello@1/);

    const limited = buildRepoMap(root, { maxFiles: 1 });
    assert.equal(limited.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("code: outlineFile filters and refuses paths outside the workspace", () => {
  const root = mkdtempSync(join(tmpdir(), "piharness-outline-"));
  try {
    writeFileSync(join(root, "a.ts"), TS_SRC);
    const all = outlineFile(root, "a.ts");
    assert.ok(all.symbols.length > 5);
    assert.equal(all.lines, TS_SRC.split("\n").length);

    const filtered = outlineFile(root, "a.ts", "config");
    assert.deepEqual(filtered.symbols.map((s) => s.name), ["Config", "loadConfig"]);

    assert.throws(() => outlineFile(root, "../etc/passwd"), /outside the workspace/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
