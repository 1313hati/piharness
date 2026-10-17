/**
 * Context service entry point: select memory facts + approved skills for a
 * goal and render them as a markdown block to prepend to a task prompt.
 */

import { loadMemory, type Memory } from "./memory.js";
import { listSkills, type SkillSummary } from "./skills.js";
import { selectContext, type ContextSelection, type SelectionBudgets } from "./selection.js";

export { loadMemory, saveMemory, addFact, removeFact, MemoryError } from "./memory.js";
export type { Memory, MemoryFact } from "./memory.js";
export { listSkills } from "./skills.js";
export type { SkillSummary } from "./skills.js";
export { selectContext, estimateTokens, goalTokens } from "./selection.js";
export type { ContextSelection, SelectionBudgets } from "./selection.js";

/**
 * Build the context injection block for a goal in this workspace.
 * Returns "" when nothing is selected (nothing to inject).
 */
export function buildContextBlock(
  workspace: string,
  goal: string,
  budgets: SelectionBudgets = {},
): string {
  return renderSelection(goal, loadMemory(workspace), listSkills(workspace), budgets);
}

/**
 * Render a selection as a markdown block. Exported for tests.
 */
export function renderSelection(
  goal: string,
  memory: Memory,
  skills: SkillSummary[],
  budgets: SelectionBudgets = {},
): string {
  const sel = selectContext(goal, memory, skills, budgets);
  const parts: string[] = [];
  if (sel.facts.length > 0) {
    const lines = sel.facts.map(({ fact, fallback }) =>
      `- ${fact.fact}${fact.tags.length > 0 ? ` [${fact.tags.join(", ")}]` : ""}` +
        (fallback ? " (general project note)" : ""),
    );
    parts.push(`Project notes (verified facts, from .harness/memory.json):\n${lines.join("\n")}`);
  }
  if (sel.skills.length > 0) {
    const blocks = sel.skills.map(({ skill }) => {
      return `### ${skill.name}: ${skill.title}\n${skill.body.trim()}`;
    });
    parts.push(`Relevant skills (from .harness/skills/ — follow them where applicable):\n${blocks.join("\n\n")}`);
  }
  if (parts.length === 0) return "";
  return parts.join("\n\n");
}
