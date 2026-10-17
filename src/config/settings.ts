/**
 * User settings — small, typed, and stored outside the repo so one person's
 * preferences do not leak into a project's git history.
 *
 * File: <agentDir>/harness-settings.json (deliberately NOT `settings.json`,
 * which Pi owns for its own compaction settings).
 *
 * Precedence: environment variables > this file > defaults. Env wins because
 * a one-off `PIHARNESS_AUTO_PROMOTE=0 piharness` should mean what it says.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../fsutil.js";

export const SETTINGS_VERSION = 1;

export interface HarnessSettings {
  version: number;
  ui: {
    /** Sample nvidia-smi and show the GPU meter. */
    gpu: boolean;
  };
  learn: {
    /** Learn from interactive sessions when they exit. */
    onExit: boolean;
    /** Promote drafts automatically once evidence is strong enough. */
    autoPromote: boolean;
    /** Independent sessions required before promotion. */
    minEvidence: number;
  };
}

export const DEFAULT_SETTINGS: HarnessSettings = {
  version: SETTINGS_VERSION,
  ui: { gpu: true },
  learn: { onExit: true, autoPromote: true, minEvidence: 2 },
};

export function settingsPath(agentDir: string): string {
  return join(agentDir, "harness-settings.json");
}

function coerce(raw: unknown): Partial<HarnessSettings> {
  const out: Partial<HarnessSettings> = {};
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Record<string, unknown>;
  const ui = r.ui as Record<string, unknown> | undefined;
  if (ui && typeof ui === "object") {
    out.ui = { gpu: ui.gpu !== false };
  }
  const learn = r.learn as Record<string, unknown> | undefined;
  if (learn && typeof learn === "object") {
    const n = Number(learn.minEvidence);
    out.learn = {
      onExit: learn.onExit !== false,
      autoPromote: learn.autoPromote !== false,
      minEvidence: Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_SETTINGS.learn.minEvidence,
    };
  }
  return out;
}

export function loadSettings(agentDir: string): HarnessSettings {
  const file = settingsPath(agentDir);
  if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS);
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
    const parsed = coerce(raw);
    return {
      version: SETTINGS_VERSION,
      ui: { ...DEFAULT_SETTINGS.ui, ...(parsed.ui ?? {}) },
      learn: { ...DEFAULT_SETTINGS.learn, ...(parsed.learn ?? {}) },
    };
  } catch {
    // A corrupt settings file must not stop the harness from starting.
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(agentDir: string, settings: HarnessSettings): void {
  mkdirSync(agentDir, { recursive: true });
  atomicWriteJson(settingsPath(agentDir), settings);
}

export type SettingResult = { ok: true; settings: HarnessSettings } | { ok: false; error: string };

/** `key=value` or separate args; unknown keys are rejected, not ignored. */
export function setSetting(agentDir: string, key: string, value: string): SettingResult {
  const settings = loadSettings(agentDir);
  const asBool = (): boolean | null => {
    if (/^(1|true|on|yes)$/i.test(value)) return true;
    if (/^(0|false|off|no)$/i.test(value)) return false;
    return null;
  };
  switch (key) {
    case "ui.gpu": {
      const b = asBool();
      if (b === null) return { ok: false, error: "ui.gpu expects true/false" };
      settings.ui.gpu = b;
      break;
    }
    case "learn.onExit": {
      const b = asBool();
      if (b === null) return { ok: false, error: "learn.onExit expects true/false" };
      settings.learn.onExit = b;
      break;
    }
    case "learn.autoPromote": {
      const b = asBool();
      if (b === null) return { ok: false, error: "learn.autoPromote expects true/false" };
      settings.learn.autoPromote = b;
      break;
    }
    case "learn.minEvidence": {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 1) return { ok: false, error: "learn.minEvidence expects a number >= 1" };
      settings.learn.minEvidence = Math.floor(n);
      break;
    }
    default:
      return { ok: false, error: `unknown setting "${key}" (ui.gpu, learn.onExit, learn.autoPromote, learn.minEvidence)` };
  }
  saveSettings(agentDir, settings);
  return { ok: true, settings };
}

export function renderSettings(settings: HarnessSettings, file: string): string[] {
  return [
    `settings  ${file}`,
    `  ui.gpu              ${settings.ui.gpu}      # GPU meter in the footer`,
    `  learn.onExit        ${settings.learn.onExit}      # learn from interactive sessions`,
    `  learn.autoPromote   ${settings.learn.autoPromote}      # promote verified drafts automatically`,
    `  learn.minEvidence   ${settings.learn.minEvidence}      # independent sessions needed to promote`,
    "",
    "  change with: piharness settings set learn.minEvidence 3",
  ];
}
