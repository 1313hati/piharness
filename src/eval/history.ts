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
import type { ScenarioManifest } from "./runner.js";

export interface HistoryEntry {
  at: string;
  scenario: string;
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
  runs: number;
  passed: number;
  passRate: number;
  bestToolCalls: number;
  avgToolCalls: number;
  bestSeconds: number;
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
          runDir: typeof e.runDir === "string" ? e.runDir : "",
        });
      }
    } catch {
      // skip junk line
    }
  }
  return out;
}

/** Per-scenario aggregation, scenarios sorted by name. */
export function summarizeHistory(entries: HistoryEntry[]): ScenarioSummary[] {
  const byScenario = new Map<string, HistoryEntry[]>();
  for (const e of entries) {
    const list = byScenario.get(e.scenario);
    if (list) list.push(e);
    else byScenario.set(e.scenario, [e]);
  }
  const summaries: ScenarioSummary[] = [];
  for (const [scenario, runs] of byScenario) {
    const passed = runs.filter((r) => r.passed).length;
    const toolCalls = runs.map((r) => r.toolCalls);
    const seconds = runs.map((r) => r.seconds);
    summaries.push({
      scenario,
      runs: runs.length,
      passed,
      passRate: passed / runs.length,
      bestToolCalls: Math.min(...toolCalls),
      avgToolCalls: toolCalls.reduce((a, b) => a + b, 0) / runs.length,
      bestSeconds: Math.min(...seconds),
      last: runs[runs.length - 1],
    });
  }
  return summaries.sort((a, b) => a.scenario.localeCompare(b.scenario));
}
