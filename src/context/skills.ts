/**
 * Approved skills: procedures at `.harness/skills/<name>/SKILL.md` (this
 * project) and `<agentDir>/skills/<name>/SKILL.md` (every project).
 * Only approved dirs are discoverable; unapproved proposals live in
 * `.harness/state/proposals/` and are never listed here (M4 boundary).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface SkillSummary {
  /** Directory name under .harness/skills/ */
  name: string;
  /** First "# " heading, or the directory name if absent. */
  title: string;
  /** First prose line after the title (truncated); used for matching. */
  description: string;
  /** Full SKILL.md content; injected when selected. */
  body: string;
  path: string;
}

export function skillsRoot(workspace: string): string {
  return join(workspace, ".harness", "skills");
}

/**
 * Skills that apply everywhere. Mirrors the agent dir (PIHARNESS_AGENT_DIR,
 * else ~/.config/piharness/agent) so the CLI, the TUI and the tests agree
 * without this module importing the Pi layer.
 */
export function globalSkillsRoot(): string {
  const override = process.env.PIHARNESS_AGENT_DIR;
  const dir = override && override.trim() ? override : join(homedir(), ".config", "piharness", "agent");
  return join(dir, "skills");
}

function parseSkillMd(name: string, body: string, path: string): SkillSummary {
  const lines = body.split("\n");
  let title = name;
  let description = "";
  let titleSeen = false;
  let inFence = false;
  for (const line of lines) {
    if (line.trimStart().startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (!titleSeen) {
      const h = line.match(/^#\s+(.+)$/);
      if (h) {
        title = h[1].trim();
        titleSeen = true;
      }
      continue;
    }
    if (line.trim() === "") continue;
    description = line.trim().replace(/^#+\s+/, "").slice(0, 240);
    break;
  }
  return { name, title, description, body, path };
}

function readSkillsIn(root: string): SkillSummary[] {
  if (!existsSync(root)) return [];
  const out: SkillSummary[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name, "SKILL.md");
    if (!existsSync(path)) continue;
    try {
      out.push(parseSkillMd(entry.name, readFileSync(path, "utf-8"), path));
    } catch {
      // Unreadable SKILL.md: skip; selection must never fail the task.
    }
  }
  return out;
}

/**
 * List approved skills: project first, then global ones this project does not
 * override (a project skill with the same name wins).
 */
export function listSkills(workspace: string): SkillSummary[] {
  const byName = new Map<string, SkillSummary>();
  for (const skill of readSkillsIn(skillsRoot(workspace))) byName.set(skill.name, skill);
  for (const skill of readSkillsIn(globalSkillsRoot())) {
    if (!byName.has(skill.name)) byName.set(skill.name, skill);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
