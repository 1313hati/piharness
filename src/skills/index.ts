/**
 * Learning service (M4) — evidence → proposed skill → evaluation → promotion.
 *
 * - proposals: inert drafts under .harness/state/proposals/ (never active)
 * - evaluate:  run verify commands, record manifests in .harness/state/evals/
 * - promote:   approve (requires passed eval) → .harness/skills/ + version
 *              snapshots in .harness/state/skill-versions/
 */

export {
  PROPOSAL_SCHEMA_VERSION,
  SkillError,
} from "./types.js";
export type {
  SkillProposal,
  ProposalStatus,
  EvalResult,
  EvalManifest,
  EvalCommandResult,
} from "./types.js";

export {
  proposalsRoot,
  validateProposalName,
  loadProposal,
  listProposals,
  saveProposal,
  renderSkillMd,
  slugifyGoal,
  proposeFromTask,
} from "./proposals.js";

export { evalsRoot, evaluateProposal, COMMAND_TIMEOUT_MS } from "./evaluate.js";

export {
  skillVersionsRoot,
  approveProposal,
  rejectProposal,
} from "./promote.js";
