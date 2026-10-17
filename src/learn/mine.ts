/**
 * The learning loop: finished session → skill proposal → evaluation →
 * promotion, with no human in the loop when the evidence is strong enough.
 *
 * Guardrails (docs/architecture.md):
 *  - A session is evidence only if it changed files *and* a canonical verify
 *    command succeeded afterwards. Chat and exploration teach nothing.
 *  - Proposals are inert drafts under .harness/state/proposals/. The context
 *    service never reads them.
 *  - Promotion needs (a) at least `minEvidence` independent sessions with the
 *    same signature and (b) a passing evaluation of the verify commands in the
 *    workspace. Two sessions that "worked" but no longer pass stay inert.
 *  - The evaluation only ever runs canonical commands derived from observed
 *    tool calls, never a free-form command string from a transcript.
 */

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { listProposals, loadProposal, saveProposal, slugifyGoal, titleFromGoal } from "../skills/proposals.js";
import { evaluateProposal } from "../skills/evaluate.js";
import { approveProposal } from "../skills/promote.js";
import { PROPOSAL_SCHEMA_VERSION } from "../skills/types.js";
import type { SkillProposal } from "../skills/types.js";
import { saveEvidence } from "./evidence.js";
import type { SessionEvidence } from "./evidence.js";

export const DEFAULT_MIN_EVIDENCE = 2;
const MAX_STEPS = 12;

export type LearnAction = "none" | "proposed" | "reinforced" | "promoted" | "blocked";

export interface LearnResult {
  action: LearnAction;
  /** Proposal name, when one was touched. */
  name?: string;
  /** Human-readable explanation, shown in the TUI and printed by the CLI. */
  reason: string;
  evidenceCount?: number;
}

export interface LearnOptions {
  /** Promote automatically once evidence is strong enough (default true). */
  autoPromote?: boolean;
  /** Independent sessions required before a draft can be promoted. */
  minEvidence?: number;
  /** Compute the result without writing anything. */
  dryRun?: boolean;
}

/**
 * What counts as "the same procedure": the canonical verify commands plus the
 * sequence of mutating/verify tools. Exploration noise (greps, reads) is
 * ignored, so two sessions that fixed different files the same way reinforce
 * each other, while a session that solved it another way does not.
 */
export function signatureOf(evidence: SessionEvidence): string {
  const names = evidence.tools
    .map((t) => t.name.toLowerCase())
    .filter((n) => n !== "read" && n !== "grep" && n !== "glob" && n !== "ls" && n !== "list");
  const collapsed = names.filter((n, i) => i === 0 || n !== names[i - 1]);
  const material = [
    [...new Set(evidence.verifyCommands)].sort().join(","),
    collapsed.slice(0, 20).join(">"),
  ].join("\n");
  return createHash("sha256").update(material).digest("hex").slice(0, 16);
}

function stepsOf(evidence: SessionEvidence): string[] {
  const steps: string[] = [];
  for (const tool of evidence.tools) {
    if (tool.status === "running") continue;
    const mark = tool.status === "error" ? " ✗" : "";
    const line = `- \`${tool.name}\`${tool.detail ? ` ${tool.detail}` : ""}${mark}`;
    if (steps[steps.length - 1] !== line) steps.push(line);
    if (steps.length >= MAX_STEPS) break;
  }
  return steps;
}

function bodyFor(evidence: SessionEvidence, sessions: string[]): string {
  const goals = evidence.goals.length > 0 ? evidence.goals.map((g) => `- ${g}`).join("\n") : "- (no prompt recorded)";
  const files = evidence.changedPaths.length > 0 ? evidence.changedPaths.map((p) => `- ${p}`).join("\n") : "- (none)";
  const verify = evidence.verifyCommands.map((c, i) => `${i + 1}. \`${c}\``).join("\n");
  return [
    "## When to use",
    goals,
    "",
    "## Steps that worked",
    ...stepsOf(evidence),
    "",
    "## Files changed",
    files,
    "",
    "## Verify",
    verify,
    "",
    "## Evidence",
    `Learned from ${sessions.length} session(s): ${sessions.join(", ")}.`,
    `${evidence.toolCalls} tool call(s), ${evidence.errors} error(s).`,
  ].join("\n");
}

function findByName(workspace: string, name: string): SkillProposal | null {
  return loadProposal(workspace, name);
}

function uniqueName(workspace: string, goal: string): string {
  const base = slugifyGoal(goal || "learned-procedure");
  let name = base;
  for (let i = 2; i <= 20; i++) {
    const taken =
      existsSync(join(workspace, ".harness", "state", "proposals", name)) ||
      existsSync(join(workspace, ".harness", "skills", name));
    if (!taken) return name;
    name = `${base}-${i}`;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Why a session cannot teach anything. Empty string means it can. */
export function rejectReason(evidence: SessionEvidence): string {
  if (evidence.toolCalls === 0) return "no tool calls, nothing to learn";
  if (evidence.changedPaths.length === 0) return "no files were changed";
  if (evidence.verifyCommands.length === 0) {
    return evidence.failedVerify.length > 0
      ? `verification failed (${evidence.failedVerify.join(", ")})`
      : "no passing verify command (run tests/typecheck before finishing)";
  }
  return "";
}

/**
 * Learn from one finished session. Writes evidence, then proposes /
 * reinforces / (optionally) promotes a skill, returning what happened.
 */
export function learnFromSession(
  workspace: string,
  evidence: SessionEvidence,
  opts: LearnOptions = {},
): LearnResult {
  const autoPromote = opts.autoPromote ?? true;
  const minEvidence = Math.max(1, opts.minEvidence ?? DEFAULT_MIN_EVIDENCE);
  const signature = signatureOf(evidence);
  // Keep the evidence even when nothing is learned: the audit trail is what
  // makes "why did it not learn that?" answerable later.
  if (!opts.dryRun) saveEvidence(workspace, evidence);

  const blocked = rejectReason(evidence);
  if (blocked) return { action: "none", reason: blocked };

  const existing = listProposals(workspace).find((p) => p.signature === signature);
  if (existing && existing.status === "approved") {
    return {
      action: "none",
      name: existing.name,
      reason: `already covered by approved skill "${existing.name}"`,
      evidenceCount: existing.evidenceCount ?? 1,
    };
  }

  const now = new Date().toISOString();
  let proposal: SkillProposal;
  let reinforced = false;
  let sessions: string[];

  if (existing) {
    const prior = existing.evidenceSessions ?? [];
    sessions = prior.includes(evidence.id) ? prior : [...prior, evidence.id];
    reinforced = sessions.length > prior.length;
    proposal = {
      ...existing,
      body: bodyFor(evidence, sessions),
      evidenceSessions: sessions,
      evidenceCount: sessions.length,
      updatedAt: now,
    };
  } else {
    sessions = [evidence.id];
    const name = uniqueName(workspace, evidence.goals[0] ?? "");
    proposal = {
      schemaVersion: PROPOSAL_SCHEMA_VERSION,
      name,
      title: titleFromGoal(evidence.goals[0] ?? "learned procedure"),
      description: `Procedure learned from a completed session (${evidence.changedPaths[0]}).`,
      body: bodyFor(evidence, sessions),
      sourceTaskId: null,
      verifyCommands: evidence.verifyCommands,
      status: "proposed",
      createdAt: now,
      updatedAt: now,
      signature,
      evidenceSessions: sessions,
      evidenceCount: 1,
    };
  }

  // Keep the union of verify commands so a later session cannot weaken the gate.
  proposal.verifyCommands = [...new Set([...proposal.verifyCommands, ...evidence.verifyCommands])];

  if (opts.dryRun) {
    return {
      action: existing ? "reinforced" : "proposed",
      name: proposal.name,
      reason: existing ? "would reinforce an existing draft" : "would draft a new proposal",
      evidenceCount: sessions.length,
    };
  }

  saveProposal(workspace, proposal);

  const count = proposal.evidenceCount ?? 1;
  if (!autoPromote) {
    return { action: reinforced ? "reinforced" : "proposed", name: proposal.name, reason: "auto-promotion disabled", evidenceCount: count };
  }
  if (count < minEvidence) {
    return {
      action: reinforced ? "reinforced" : "proposed",
      name: proposal.name,
      reason: `drafted (${count}/${minEvidence} sessions needed before promotion)`,
      evidenceCount: count,
    };
  }

  // Gate: the proposal must still verify in this workspace, right now.
  let evaluation;
  try {
    evaluation = evaluateProposal(workspace, proposal.name);
  } catch (err) {
    return {
      action: "blocked",
      name: proposal.name,
      reason: `evaluation could not run: ${err instanceof Error ? err.message : String(err)}`,
      evidenceCount: count,
    };
  }
  if (!evaluation.passed) {
    return {
      action: "blocked",
      name: proposal.name,
      reason: "promotion blocked: verification failed in this workspace",
      evidenceCount: count,
    };
  }
  const promoted = approveProposal(workspace, proposal.name);
  promoted.autoPromoted = true;
  saveProposal(workspace, promoted);
  return { action: "promoted", name: promoted.name, reason: "verified and promoted to .harness/skills/", evidenceCount: count };
}

export { findByName };
