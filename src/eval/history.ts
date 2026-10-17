/**
 * Evaluation history (M6) — one JSONL line per scenario run, appended to
 * `.harness/state/evals/history.jsonl`, plus the aggregation used by
 * `harness eval score`.
 *
 * The manifests under `.harness/state/evals/<scenario>-<ts>/` stay the source
 * of truth for a single run; the history file exists so pass rate, cost and
 * repair cycles can be compared across runs without walking directories.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ScenarioManifest, ScenarioVariant } from "./runner.js";

export interface HistoryEntry {
  at: string;
  scenario: string;
  /** "skills" (learned procedures present) or "no-skills" (baseline arm). */
  variant: ScenarioVariant;
  passed: boolean;
  phase: string;
  toolCalls: number;
  repairCycles: number;
  seconds: number;
  model: string;
  /** Repo-relative directory holding this run's manifest and work tree. */
  runDir: string;
}

export interface ScenarioSummary {
  scenario: string;
  variant: ScenarioVariant;
  runs: number;
  passed: number;
  passRate: number;
  /**
   * Cost statistics only over runs that actually called a tool. A run that
   * never reached the backend records 0 tool calls and ~30s of connect
   * retries; including it made "best tools" read 0, which looks like a free
   * perfect run instead of a broken one. `null` = no run has cost data.
   */
  bestToolCalls: number | null;
  avgToolCalls: number | null;
  bestSeconds: number | null;
  last: HistoryEntry;
}

export function historyPath(repoRoot: string): string {
  return join(repoRoot, ".harness", "state", "evals", "history.jsonl");
}

/** Append one run to the JSONL history. Best effort: history never fails a run. */
export function appendHistory(repoRoot: string, manifest: ScenarioManifest, runDir: string): void {
  const entry: HistoryEntry = {
    at: manifest.at,
    scenario: manifest.scenario,
    variant: manifest.variant,
    passed: manifest.passed,
    phase: manifest.phase,
    toolCalls: manifest.budgets.toolCallsUsed,
    repairCycles: manifest.budgets.repairCyclesUsed,
    seconds: Math.round(manifest.durationMs / 100) / 10,
    model: manifest.model,
    runDir,
  };
  const file = historyPath(repoRoot);
  try {
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // Evidence is already in the manifest; a read-only .harness must not
    // turn a completed run into a failure.
  }
}

/**
 * Read the history in append order, skipping malformed lines (a truncated
 * write must not make every later run unreadable).
 */
export function readHistory(repoRoot: string): HistoryEntry[] {
  const file = historyPath(repoRoot);
  if (!existsSync(file)) return [];
  const out: HistoryEntry[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const e = JSON.parse(trimmed) as HistoryEntry;
      if (
        typeof e.scenario === "string" &&
        typeof e.passed === "boolean" &&
        typeof e.at === "string"
      ) {
        out.push({
          ...e,
          toolCalls: Number(e.toolCalls) || 0,
          repairCycles: Number(e.repairCycles) || 0,
          seconds: Number(e.seconds) || 0,
          phase: typeof e.phase === "string" ? e.phase : "unknown",
          model: typeof e.model === "string" ? e.model : "unknown",
          variant: e.variant === "no-skills" ? "no-skills" : "skills",
          runDir: typeof e.runDir === "string" ? e.runDir : "",
        });
      }
    } catch {
      // skip junk line
    }
  }
  return out;
}

/**
 * Per-scenario-per-variant aggregation. Arms stay separate: pooling a
 * `skills` run with a `no-skills` run would hide exactly the difference the
 * scoreboard exists to show.
 */
export function summarizeHistory(entries: HistoryEntry[]): ScenarioSummary[] {
  const byKey = new Map<string, { scenario: string; variant: ScenarioVariant; runs: HistoryEntry[] }>();
  for (const e of entries) {
    const key = `${e.scenario}::${e.variant}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.runs.push(e);
    else byKey.set(key, { scenario: e.scenario, variant: e.variant, runs: [e] });
  }
  const summaries: ScenarioSummary[] = [];
  for (const { scenario, variant, runs } of byKey.values()) {
    const passed = runs.filter((r) => r.passed).length;
    const worked = runs.filter((r) => r.toolCalls > 0);
    const toolCalls = worked.map((r) => r.toolCalls);
    const seconds = worked.map((r) => r.seconds);
    summaries.push({
      scenario,
      variant,
      runs: runs.length,
      passed,
      passRate: passed / runs.length,
      bestToolCalls: toolCalls.length > 0 ? Math.min(...toolCalls) : null,
      avgToolCalls:
        toolCalls.length > 0 ? toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length : null,
      bestSeconds: seconds.length > 0 ? Math.min(...seconds) : null,
      last: runs[runs.length - 1],
    });
  }
  return summaries.sort(
    (a, b) =>
      a.scenario.localeCompare(b.scenario) ||
      // baseline arm first, so "skills vs no-skills" reads left to right
      a.variant.localeCompare(b.variant),
  );
}
