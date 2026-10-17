import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildSkillsBlock, listSkills } from "../src/context/index.js";
import { createBuiltinExtensions } from "../src/extensions/builtin.js";
import { harnessInlineExtensions } from "../src/pi/extensions.js";

/**
 * Global skills live under <agentDir>/skills, so a procedure learned in one
 * project reaches the others — and into the interactive TUI, which is where
 * the user actually works.
 */
function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function writeSkill(root: string, name: string, body: string): void {
  mkdirSync(join(root, name), { recursive: true });
  writeFileSync(join(root, name, "SKILL.md"), body, "utf-8");
}

function withAgentDir<T>(agentDir: string, fn: () => T): T {
  const original = process.env.PIHARNESS_AGENT_DIR;
  process.env.PIHARNESS_AGENT_DIR = agentDir;
  try {
    return fn();
  } finally {
    if (original === undefined) delete process.env.PIHARNESS_AGENT_DIR;
    else process.env.PIHARNESS_AGENT_DIR = original;
  }
}

test("global skills: listed when the project has none", () => {
  const agentDir = scratch("harness-agent-");
  const workspace = scratch("harness-ws-");
  try {
    writeSkill(join(agentDir, "skills"), "measure-first", "# Measure first\nCompute numbers before writing them into code.\n");
    withAgentDir(agentDir, () => {
      assert.deepEqual(listSkills(workspace).map((s) => s.name), ["measure-first"]);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("global skills: a project skill with the same name wins", () => {
  const agentDir = scratch("harness-agent-");
  const workspace = scratch("harness-ws-");
  try {
    writeSkill(join(agentDir, "skills"), "measure-first", "# Global measure\nGlobal version.\n");
    writeSkill(join(workspace, ".harness", "skills"), "measure-first", "# Local measure\nProject version wins.\n");
    withAgentDir(agentDir, () => {
      const matched = listSkills(workspace).filter((s) => s.name === "measure-first");
      assert.equal(matched.length, 1);
      assert.equal(matched[0].title, "Local measure");
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("global skills: merged with project skills", () => {
  const agentDir = scratch("harness-agent-");
  const workspace = scratch("harness-ws-");
  try {
    writeSkill(join(agentDir, "skills"), "measure-first", "# Measure first\nCompute numbers.\n");
    writeSkill(join(workspace, ".harness", "skills"), "project-only", "# Project only\nLocal procedure.\n");
    withAgentDir(agentDir, () => {
      assert.deepEqual(listSkills(workspace).map((s) => s.name).sort(), ["measure-first", "project-only"]);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("global skills: a matched skill is selected for the turn", () => {
  const agentDir = scratch("harness-agent-");
  const workspace = scratch("harness-ws-");
  try {
    writeSkill(
      join(agentDir, "skills"),
      "measure-first",
      "# Evidence before code\nMeasure timing and distance values before writing code that depends on them.\n",
    );
    withAgentDir(agentDir, () => {
      const block = buildSkillsBlock(workspace, "work out the timing and distance for this jump");
      assert.match(block, /Evidence before code/);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("global skills: before_agent_start injects them into the system prompt", () => {
  const agentDir = scratch("harness-agent-");
  const workspace = scratch("harness-ws-");
  try {
    writeSkill(
      join(agentDir, "skills"),
      "verify-before-claim",
      "# Prove the change\nRun the command that proves the change and read its output before reporting success.\n",
    );
    withAgentDir(agentDir, () => {
      const built = createBuiltinExtensions({ cwd: workspace, agentDir });
      const [extension] = harnessInlineExtensions(built.extensions, { cwd: workspace, agentDir });
      let handler: ((event: { systemPrompt: string; prompt?: string }) => { systemPrompt: string } | undefined) | undefined;
      const fakePi = {
        registerTool: () => {},
        on: (name: string, fn: typeof handler) => {
          if (name === "before_agent_start") handler = fn;
        },
      };
      // The factory only reaches for the Pi API surface it needs.
      extension.factory(fakePi as never);
      assert.ok(handler, "before_agent_start must be registered");
      const result = handler({ systemPrompt: "You are operating inside pi, a coding agent.", prompt: "fix the bug and prove the change" });
      assert.ok(result);
      assert.match(result.systemPrompt, /Prove the change/);
      assert.match(result.systemPrompt, /operating inside piharness,/);
    });
  } finally {
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(workspace, { recursive: true, force: true });
  }
});
