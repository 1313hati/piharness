import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectEnvironment, renderEnvironment, type Runner } from "../src/context/environment.js";
import { renderHarnessContext } from "../src/extensions/builtin.js";

/**
 * The block exists to stop a turn wasting calls on things this machine cannot
 * do, so the tests are about the claims it makes: what is listed as installed,
 * what is listed as absent, and whether a python script may import anything.
 */

function makeRunner(opts: {
  present: string[];
  versions?: Record<string, string>;
  os?: string;
  modules?: string[];
}): Runner {
  const present = new Set(opts.present);
  return (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    if (line.includes("for n in")) {
      return { ok: true, out: [...present].join("\n") };
    }
    if (line.includes("/etc/os-release")) return { ok: true, out: `PRETTY_NAME="${opts.os ?? "Test Linux"}"` };
    if (cmd === "python3" && args[0] === "-c") {
      return { ok: true, out: (opts.modules ?? []).join(" ") };
    }
    const v = opts.versions?.[line];
    return v ? { ok: true, out: v } : { ok: false, out: "" };
  };
}

test("reports what is installed, with versions, and what is absent", () => {
  const run = makeRunner({
    present: ["python3", "node", "git"],
    versions: {
      "python3 --version": "Python 3.14.8",
      "node --version": "v26.12.1",
      "git --version": "git version 2.56.0",
      "python3 -m pip --version": "pip 26.2.1 from /usr/lib/python3.14/site-packages/pip",
    },
    modules: ["PIL", "requests"],
  });
  const report = detectEnvironment(run);
  assert.equal(report.os, "Test Linux");
  assert.deepEqual(report.present, ["python3 3.14.8", "node 26.12.1", "git 2.56.0"]);
  assert.ok(report.absent.includes("uv"), "uv must be reported absent");
  assert.equal(report.pythonPackaging, "python3 -m pip 26.2.1");
  assert.deepEqual(report.pythonModules, ["PIL", "requests"]);

  const text = renderEnvironment(report);
  assert.match(text, /- installed: python3 3\.14\.8, node 26\.12\.1, git 2\.56\.0/);
  assert.match(text, /- not installed: .*uv.*do not call them/);
  assert.match(text, /python packaging: python3 -m pip 26\.2\.1/);
  assert.match(text, /can import: PIL, requests/);
});

test("no working python installer is said plainly — that is the whole point", () => {
  const run = makeRunner({ present: ["python3", "git"], versions: { "python3 --version": "Python 3.14.8" } });
  const text = renderEnvironment(detectEnvironment(run));
  assert.match(text, /python packaging: none works — do not try to install packages/);
  assert.match(text, /imports no third-party modules: write stdlib-only Python/);
});

test("pip3 alone counts only if it runs", () => {
  const broken = makeRunner({ present: ["python3"], versions: { "python3 --version": "Python 3.14.8" } });
  assert.match(renderEnvironment(detectEnvironment(broken)), /none works/);

  const working = makeRunner({
    present: ["python3"],
    versions: { "python3 --version": "Python 3.14.8", "pip3 --version": "pip 24.0" },
  });
  assert.match(renderEnvironment(detectEnvironment(working)), /pip3 24\.0/);
});

test("no python3: packaging is reported as such and no import claim is made", () => {
  const run = makeRunner({ present: ["node"], versions: { "node --version": "v26.0.0" } });
  const text = renderEnvironment(detectEnvironment(run));
  assert.match(text, /python packaging: no python3/);
  assert.doesNotMatch(text, /can import/);
  assert.doesNotMatch(text, /stdlib-only/);
});

test("the block stays small enough to be worth its tokens", () => {
  const run = makeRunner({
    present: ["python3", "node", "npm", "git", "jq", "ffmpeg", "sqlite3", "docker", "cargo", "tmux", "deno"],
    versions: { "python3 --version": "Python 3.14.8" },
  });
  const text = renderEnvironment(detectEnvironment(run));
  assert.ok(text.length < 900, `block was ${text.length} chars`);
  const capped = renderEnvironment(detectEnvironment(run), 40);
  assert.ok(capped.length <= 40 + 40);
  assert.match(capped, /truncated/);
});

test("the per-turn context carries the machine facts", () => {
  // Wiring, not formatting: the block is worthless if a refactor drops it from
  // what the model actually receives.
  const dir = mkdtempSync(join(tmpdir(), "piharness-env-"));
  const context = renderHarnessContext({ cwd: dir, agentDir: dir });
  assert.match(context, /## This machine \(probed, not assumed\)/);
  assert.match(context, /python packaging:/);
});
