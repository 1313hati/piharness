/**
 * Skill proposal store — .harness/state/proposals/<name>/proposal.json
 *
 * Proposals are inert drafts. They are NEVER discoverable as active skills:
 * the context service (src/context/skills.ts) only reads .harness/skills/.
 *
 * Drafts are deterministic and LLM-free: a completed TaskRecord is the
 * evidence, and the draft captures goal, what changed, and how to verify.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../fsutil.js";
import type { TaskRecord } from "../task/types.js";
import { PROPOSAL_SCHEMA_VERSION, SkillError } from "./types.js";
import type { SkillProposal } from "./types.js";

export function proposalsRoot(workspace: string): string {
  return join(workspace, ".harness", "state", "proposals");
}

const NAME_RE = /^[\w-]{1,64}$/;

export function validateProposalName(name: string): string {
  if (!NAME_RE.test(name)) {
    throw new SkillError(
      `invalid proposal name "${name}" (use 1-64 word characters or dashes)`,
    );
  }
  return name;
}

function proposalDir(workspace: string, name: string): string {
  validateProposalName(name);
  return join(proposalsRoot(workspace), name);
}

function proposalFile(workspace: string, name: string): string {
  return join(proposalDir(workspace, name), "proposal.json");
}

export function loadProposal(
  workspace: string,
  name: string,
): SkillProposal | null {
  const file = proposalFile(workspace, name);
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as SkillProposal;
    if (raw.schemaVersion !== PROPOSAL_SCHEMA_VERSION) return null;
    if (typeof raw.name !== "string" || typeof raw.body !== "string") return null;
    return raw;
  } catch {
    // Corrupt proposal: treat as absent (never crash discovery on one bad file).
    return null;
  }
}

export function listProposals(workspace: string): SkillProposal[] {
  const root = proposalsRoot(workspace);
  if (!existsSync(root)) return [];
  const out: SkillProposal[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const p = loadProposal(workspace, entry.name);
    if (p) out.push(p);
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function saveProposal(workspace: string, p: SkillProposal): void {
  const file = proposalFile(workspace, p.name);
  mkdirSync(proposalDir(workspace, p.name), { recursive: true });
  atomicWriteJson(file, p);
}

/** Full SKILL.md content for a proposal. */
export function renderSkillMd(p: SkillProposal): string {
  return `# ${p.title}\n${p.description}\n\n${p.body.trim()}\n`;
}

/**
 * Derive a deterministic slug from a task goal.
 */
export function slugifyGoal(goal: string): string {
  const slug = goal
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return slug || "learned-skill";
}

function nameTaken(workspace: string, name: string): boolean {
  return (
    existsSync(proposalFile(workspace, name)) ||
    existsSync(join(workspace, ".harness", "skills", name, "SKILL.md"))
  );
}

/**
 * Draft a skill proposal from a completed task.
 *
 * Only COMPLETED tasks provide evidence: learning from a failed run could
 * encode the wrong procedure, and a failed reflection must never turn a
 * successful task into a failed one (docs/architecture.md).
 */
export function proposeFromTask(
  workspace: string,
  task: TaskRecord,
): SkillProposal {
  if (task.phase !== "completed") {
    throw new SkillError(
      `only completed tasks can seed a skill proposal (task ${task.id} is "${task.phase}")`,
    );
  }
  const base = slugifyGoal(task.goal);
  let name = base;
  for (let i = 2; nameTaken(workspace, name) && i <= 9; i++) {
    name = `${base}-${i}`;
  }
  if (nameTaken(workspace, name)) {
    throw new SkillError(
      `too many proposals already exist for goal "${task.goal}"`,
    );
  }
  const now = new Date().toISOString();
  const changed =
    task.changedPaths.length > 0
      ? task.changedPaths.map((p) => `  - ${p}`).join("\n")
      : "  - (no changed paths recorded)";
  const verify =
    task.checks.filter((c) => c.command).length > 0
      ? task.checks
          .filter((c) => c.command)
          .map((c, i) => `${i + 1}. \`${c.command}\` — ${c.description}`)
          .join("\n")
      : "  - (no verify commands recorded)";
  const body = [
    "## Goal",
    task.goal,
    "",
    "## What worked",
    changed,
    "",
    "## Verify",
    verify,
    "",
    `Learned from task ${task.id}${task.piSessionId ? ` (Pi session ${task.piSessionId})` : ""}.`,
  ].join("\n");
  const p: SkillProposal = {
    schemaVersion: PROPOSAL_SCHEMA_VERSION,
    name,
    title: task.goal.trim().slice(0, 120),
    description: `Procedure learned from completed task ${task.id}.`,
    body,
    sourceTaskId: task.id,
    verifyCommands: task.checks.filter((c) => c.command).map((c) => c.command as string),
    status: "proposed",
    createdAt: now,
    updatedAt: now,
  };
  saveProposal(workspace, p);
  return p;
}
