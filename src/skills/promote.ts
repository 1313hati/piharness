/**
 * Promotion — approve a passed proposal into .harness/skills/ (where the
 * context service discovers active skills), snapshotting any prior version
 * to .harness/state/skill-versions/ (immutable content + hash).
 *
 * Rules enforced here (docs/architecture.md):
 *  - approve requires a PASSED evaluation (evaluation → promotion gate)
 *  - only "proposed" status can transition (no re-approve of rejected,
 *    and an already-approved skill is managed by editing .harness/skills/)
 */

import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWriteJson } from "../fsutil.js";
import { loadProposal, renderSkillMd, saveProposal } from "./proposals.js";
import { SkillError } from "./types.js";
import type { SkillProposal } from "./types.js";

export function skillVersionsRoot(workspace: string): string {
  return join(workspace, ".harness", "state", "skill-versions");
}

function skillFile(workspace: string, name: string): string {
  return join(workspace, ".harness", "skills", name, "SKILL.md");
}

/** Atomically write a text file (tmp + rename). */
function atomicWriteText(file: string, content: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

interface SkillVersionSnapshot {
  schemaVersion: number;
  name: string;
  at: string;
  /** Proposal that caused the overwrite (null if overwritten by hand). */
  sourceProposal: string | null;
  sha256: string;
  content: string;
}

/**
 * Approve a proposal: it must exist, be "proposed", and have passed
 * evaluation. Installs .harness/skills/<name>/SKILL.md, snapshotting the
 * previous content first if one exists.
 */
export function approveProposal(workspace: string, name: string): SkillProposal {
  const p = loadProposal(workspace, name);
  if (!p) throw new SkillError(`no proposal named "${name}"`);
  if (p.status === "approved") {
    throw new SkillError(`proposal "${name}" is already approved`);
  }
  if (p.status === "rejected") {
    throw new SkillError(`proposal "${name}" was rejected (draft a new one)`);
  }
  if (!p.evalResult || !p.evalResult.passed) {
    throw new SkillError(
      `proposal "${name}" has not passed evaluation (run: harness skill evaluate ${name})`,
    );
  }

  const target = skillFile(workspace, name);
  if (existsSync(target)) {
    const prev = readFileSync(target, "utf8");
    const snapshot: SkillVersionSnapshot = {
      schemaVersion: 1,
      name,
      at: new Date().toISOString(),
      sourceProposal: name,
      sha256: createHash("sha256").update(prev).digest("hex"),
      content: prev,
    };
    atomicWriteJson(
      join(skillVersionsRoot(workspace), name, `${Date.now().toString(36)}.json`),
      snapshot,
    );
  }

  atomicWriteText(target, renderSkillMd(p));
  const at = new Date().toISOString();
  p.status = "approved";
  p.approvedAt = at;
  p.updatedAt = at;
  saveProposal(workspace, p);
  return p;
}

/**
 * Reject a proposal (keeps the record for inspection; it was never active).
 */
export function rejectProposal(workspace: string, name: string): SkillProposal {
  const p = loadProposal(workspace, name);
  if (!p) throw new SkillError(`no proposal named "${name}"`);
  if (p.status === "approved") {
    throw new SkillError(
      `proposal "${name}" is already approved; remove .harness/skills/${name} to retire it`,
    );
  }
  if (p.status === "rejected") {
    throw new SkillError(`proposal "${name}" is already rejected`);
  }
  p.status = "rejected";
  p.updatedAt = new Date().toISOString();
  saveProposal(workspace, p);
  return p;
}
