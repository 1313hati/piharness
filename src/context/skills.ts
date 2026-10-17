/**
 * Approved project skills: procedures at `.harness/skills/<name>/SKILL.md`.
 * Only skills in this directory are discoverable; unapproved proposals live
 * in `.harness/state/proposals/` and are never listed here (M4 boundary).
 */

import { readFileSync, existsSync, readdirSync } from "node:fs";
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

/** List approved skills. Missing skills dir → empty list. */
export function listSkills(workspace: string): SkillSummary[] {
  const root = skillsRoot(workspace);
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
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
