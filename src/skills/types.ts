/**
 * Learning service types: skill proposals, evaluation results, promotion.
 *
 * Pipeline (docs/architecture.md "Learning service"):
 *   evidence (completed task) → proposed skill → evaluation → promotion
 *
 * Trust rule: a proposal is inert until approved. Rejected and unapproved
 * proposals live under .harness/state/proposals/ and are never discoverable
 * by the context service (which only reads .harness/skills/).
 */

export const PROPOSAL_SCHEMA_VERSION = 1;

export type ProposalStatus = "proposed" | "approved" | "rejected";

/** Outcome of running a proposal's verify commands. */
export interface EvalResult {
  passed: boolean;
  /** Exit code of the last command that ran (-1 when none ran). */
  exitCode: number;
  /** The last command that ran ("" when none). */
  command: string;
  /** Tail of the last command's output (diagnostic). */
  outputTail: string;
  at: string;
}

export interface SkillProposal {
  schemaVersion: number;
  /** Directory name under .harness/state/proposals/ and (when approved) .harness/skills/. */
  name: string;
  title: string;
  description: string;
  /** Markdown body of the skill (steps, verification). */
  body: string;
  /** Task the proposal was learned from (null for hand-written drafts). */
  sourceTaskId: string | null;
  /** Commands to run to verify the skill still holds (from the task's checks). */
  verifyCommands: string[];
  status: ProposalStatus;
  createdAt: string;
  updatedAt: string;
  evalResult?: EvalResult;
  approvedAt?: string;
  /**
   * Stable hash of (verify commands + effective tool sequence). Two sessions
   * that solved a problem the same way share a signature, so the second one
   * reinforces the draft instead of cloning it.
   */
  signature?: string;
  /** Session ids that produced this draft (evidence trail). */
  evidenceSessions?: string[];
  /** Number of independent sessions behind the draft. */
  evidenceCount?: number;
  /** True when the learning loop promoted it without a human in the loop. */
  autoPromoted?: boolean;
}

export class SkillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillError";
  }
}

/** One verify command's outcome inside an eval manifest. */
export interface EvalCommandResult {
  command: string;
  ok: boolean;
  exitCode: number;
  outputTail: string;
}

export interface EvalManifest {
  schemaVersion: number;
  proposal: string;
  at: string;
  commands: EvalCommandResult[];
  passed: boolean;
}
