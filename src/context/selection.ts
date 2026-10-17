/**
 * Relevance selection for task context: pick memory facts and skills for a
 * goal under a small token budget (~1k memory, ~2k skills — see
 * docs/architecture.md). Deterministic: score by shared tokens, then budget.
 */

import type { Memory, MemoryFact } from "./memory.js";
import type { SkillSummary } from "./skills.js";

export interface SelectionBudgets {
  /** Token cap for the memory section (default 1000). */
  memoryTokens?: number;
  /** Token cap for the skills section (default 2000). */
  skillTokens?: number;
}

export interface SelectedFact {
  fact: MemoryFact;
  /** Number of distinct goal tokens found in the fact text + tags. */
  score: number;
  /** True when included despite score 0 (no-match fallback). */
  fallback: boolean;
}

export interface SelectedSkill {
  skill: SkillSummary;
  score: number;
}

export interface ContextSelection {
  facts: SelectedFact[];
  skills: SelectedSkill[];
  memoryTokens: number;
  skillTokens: number;
}

/** Rough token estimate: ~4 chars per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Distinct goal tokens (lowercase alnum, length >= 3). */
export function goalTokens(goal: string): Set<string> {
  const words = goal.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
  return new Set(words.filter((w) => w.length >= 3));
}

function scoreAgainst(tokens: Set<string>, text: string): number {
  let score = 0;
  const hay = text.toLowerCase();
  for (const t of tokens) if (hay.includes(t)) score++;
  return score;
}

const MAX_SKILLS = 3;
const NO_MATCH_FACT_FALLBACK = 3;

/**
 * Select the memory facts and skills to inject for this goal.
 * - Facts: ranked by shared-token score; all with score > 0 fit within the
 *   memory budget. If nothing matches, fall back to the most recent few
 *   facts (general project notes are usually still useful).
 * - Skills: only matched skills (score > 0), max MAX_SKILLS, skill budget.
 */
export function selectContext(
  goal: string,
  memory: Memory,
  skills: SkillSummary[],
  budgets: SelectionBudgets = {},
): ContextSelection {
  const memoryCap = budgets.memoryTokens ?? 1000;
  const skillCap = budgets.skillTokens ?? 2000;
  const tokens = goalTokens(goal);

  // ── Facts ──
  const scored = memory.facts.map((fact) => ({
    fact,
    score: scoreAgainst(tokens, `${fact.fact} ${fact.tags.join(" ")}`),
  }));
  // Score desc; ties broken most-recent first (fallback prefers recent notes).
  scored.sort((a, b) => b.score - a.score || b.fact.createdAt.localeCompare(a.fact.createdAt));

  const facts: SelectedFact[] = [];
  let memoryTokens = 0;
  const best = scored[0]?.score ?? 0;
  for (const { fact, score } of scored) {
    const cost = estimateTokens(fact.fact) + 8;
    const isFallback = score === 0 && best === 0;
    const matchesBudget = memoryTokens + cost <= memoryCap;
    if ((score > 0 || (isFallback && facts.length < NO_MATCH_FACT_FALLBACK)) && matchesBudget) {
      facts.push({ fact, score, fallback: isFallback });
      memoryTokens += cost;
    }
  }

  // ── Skills ──
  const skillScored = skills
    .map((skill) => ({
      skill,
      score: scoreAgainst(tokens, `${skill.title} ${skill.description} ${skill.name}`),
    }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .slice(0, MAX_SKILLS);

  const skillsOut: SelectedSkill[] = [];
  let skillTokens = 0;
  for (const { skill, score } of skillScored) {
    const cost = estimateTokens(skill.body);
    if (skillTokens + cost > skillCap) continue;
    skillsOut.push({ skill, score });
    skillTokens += cost;
  }

  return { facts, skills: skillsOut, memoryTokens, skillTokens };
}
