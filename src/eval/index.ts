/**
 * Evaluation harness (M5) — scenarios under evals/scenarios/, run into
 * .harness/state/evals/<scenario>-<ts>/ (manifest + work tree).
 */

export {
  SCENARIO_SCHEMA_VERSION,
  EvalError,
  scenariosRoot,
  loadScenario,
  listScenarios,
  findScenario,
} from "./scenarios.js";
export type { Scenario } from "./scenarios.js";

export {
  SCENARIO_MANIFEST_VERSION,
  evalsDir,
  runScenario,
  listRunDirs,
} from "./runner.js";
export type { ScenarioManifest, ScenarioRun, ScenarioRunner } from "./runner.js";

export { historyPath, appendHistory, readHistory, summarizeHistory } from "./history.js";
export type { HistoryEntry, ScenarioSummary } from "./history.js";
