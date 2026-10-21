import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { detectProjectChecks, renderProjectChecks } from "../src/context/project.js";
import {
  ReadBeforeEdit,
  TurnGuard,
  isCodeFile,
  isVerificationCommand,
  renderVerifyNudge,
} from "../src/quality/verify.js";

function tmp(files: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "piharness-verify-"));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

test("project checks come from what the project already declares", () => {
  const dir = tmp({
    "package.json": JSON.stringify({ scripts: { typecheck: "tsc --noEmit", test: "tsx --test", build: "tsc", lint: "eslint ." } }),
    "tsconfig.json": "{}",
  });
  const checks = detectProjectChecks(dir);
  assert.deepEqual(checks.commands, ["npm run typecheck", "npm test", "npm run build"]);
  assert.ok(checks.source.includes("package.json scripts"));
  const line = renderProjectChecks(checks);
  assert.match(line, /project checks \(run before you say it works\): npm run typecheck, npm test, npm run build/);
});

test("tsconfig alone still yields a check, and an empty dir yields none", () => {
  assert.deepEqual(detectProjectChecks(tmp({ "tsconfig.json": "{}" })).commands, ["npx tsc --noEmit"]);
  const empty = detectProjectChecks(tmp());
  assert.deepEqual(empty.commands, []);
  assert.equal(renderProjectChecks(empty), "");
});

test("cargo, go and make projects are recognised", () => {
  assert.deepEqual(detectProjectChecks(tmp({ "Cargo.toml": "[package]" })).commands, ["cargo check", "cargo test"]);
  assert.deepEqual(detectProjectChecks(tmp({ "go.mod": "module x" })).commands, ["go build ./...", "go test ./..."]);
  assert.deepEqual(detectProjectChecks(tmp({ Makefile: "build:\n\ttrue\ntest:\n\ttrue\n" })).commands, ["make test"]);
});

test("verification means something was tested, built or run", () => {
  for (const cmd of [
    "npm test",
    "cd src && npm test -- --watch=false",
    "npm run typecheck",
    "npx tsc --noEmit",
    "cargo check",
    "go test ./...",
    "python3 -m pytest -q",
    "node --test tests/a.test.ts",
    "python3 view_dog.py",
    "./dist/cli.js doctor",
  ]) {
    assert.equal(isVerificationCommand(cmd), true, `should count: ${cmd}`);
  }
  for (const cmd of [
    "npm install",
    "npm run dev",
    "pip install numpy",
    "git status",
    "cat package.json",
    "ls -la",
    "echo test",
  ]) {
    assert.equal(isVerificationCommand(cmd), false, `should not count: ${cmd}`);
  }
});

test("a turn that edits code and checks nothing is unverified, once", () => {
  const guard = new TurnGuard();
  guard.note({ name: "write", input: { path: "src/a.ts" } });
  guard.note({ name: "edit", input: { path: "src/b.ts" } });
  assert.deepEqual(guard.editedFiles, ["src/a.ts", "src/b.ts"]);
  assert.equal(guard.unverified, true);
  assert.equal(guard.shouldNudge(), true);
  guard.markNudged();
  assert.equal(guard.shouldNudge(), false, "one nudge per turn, not a loop");

  const text = renderVerifyNudge(guard.editedFiles, guard.checkCommands, ["npm test"]);
  assert.match(text, /src\/a\.ts/);
  assert.match(text, /Run npm test/);
  assert.match(text, /unverified, not finished/);

  guard.reset();
  assert.equal(guard.shouldNudge(), false);
});

test("checks and prose edits do not trigger the gate", () => {
  const checked = new TurnGuard();
  checked.note({ name: "edit", input: { path: "src/a.ts" } });
  checked.note({ name: "bash", input: { command: "npm test" } });
  assert.equal(checked.unverified, false);
  assert.equal(checked.shouldNudge(), false);

  const docs = new TurnGuard();
  docs.note({ name: "write", input: { path: "docs/progress.md" } });
  assert.equal(isCodeFile("docs/progress.md"), false);
  assert.equal(docs.shouldNudge(), false);

  const failed = new TurnGuard();
  failed.note({ name: "edit", input: { path: "src/a.ts" }, failed: true });
  assert.deepEqual(failed.editedFiles, []);
});

test("editing a file the session never read is blocked, and reading unblocks it", () => {
  const dir = tmp({ "b.ts": "export const b = 1;\n" });
  const guard = new ReadBeforeEdit(dir);
  assert.match(String(guard.blockReason("b.ts")), /read b\.ts before editing/);
  guard.noteRead("b.ts");
  assert.equal(guard.blockReason("b.ts"), null);
  assert.equal(guard.blockReason(join(dir, "b.ts")), null, "relative and absolute are the same file");
  guard.noteWrite("c.ts");
  assert.equal(guard.blockReason("c.ts"), null, "a file this session wrote is known");
  guard.noteBash("cat -n d.ts | head");
  assert.equal(guard.blockReason("d.ts"), null, "cat counts as reading");
  guard.noteBash("git log --oneline");
  assert.notEqual(guard.blockReason("e.ts"), null);
});
