/**
 * Stale-build detection.
 *
 * piharness runs from `dist/`, so editing `src/` changes nothing until someone
 * runs `npm run build`. That gap has already cost a debugging session: a fix
 * was written, reviewed and tested, and the binary that ran the next turn was
 * still the previous day's UI. This module is the guard: if the entry point is
 * older than the newest source file, say so once, on stderr, and keep going.
 *
 * Installed copies have no `src/` next to `dist/`, so they never see this.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

export interface StaleBuild {
  /** Entry point that is running, e.g. dist/cli.js. */
  entry: string;
  /** Newest file under src/, which is newer than the entry. */
  newest: string;
  /** How much newer, in milliseconds. */
  ageMs: number;
}

/** Newest mtime (ms) of any file under `dir`, recursively; 0 when unreadable. */
export function newestMtime(dir: string): { path: string; mtimeMs: number } | null {
  let best: { path: string; mtimeMs: number } | null = null;
  const walk = (current: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(current);
    } catch {
      return;
    }
    for (const name of entries) {
      const path = join(current, name);
      let info;
      try {
        info = statSync(path);
      } catch {
        continue;
      }
      if (info.isDirectory()) {
        walk(path);
      } else if (info.isFile() && (!best || info.mtimeMs > best.mtimeMs)) {
        best = { path, mtimeMs: info.mtimeMs };
      }
    }
  };
  walk(dir);
  return best;
}

/**
 * Compare the running bundle with the sources beside it. `null` means either
 * there are no sources (installed package) or the build is current.
 */
export function detectStaleBuild(entry: string, srcDir: string): StaleBuild | null {
  let entryMtime: number;
  try {
    entryMtime = statSync(entry).mtimeMs;
  } catch {
    return null;
  }
  const newest = newestMtime(srcDir);
  if (!newest) return null;
  // Two seconds covers a build that writes dist/ just before src/ settles.
  const ageMs = newest.mtimeMs - entryMtime;
  if (ageMs < 2_000) return null;
  return { entry, newest: newest.path, ageMs };
}

/** One line, no colour: this goes to stderr before the TUI takes the screen. */
export function formatStaleBuild(stale: StaleBuild): string {
  const hours = stale.ageMs / 3_600_000;
  const age = hours >= 1 ? `${hours.toFixed(1)}h` : `${Math.round(stale.ageMs / 60_000)}m`;
  return (
    `piharness: this build is ${age} older than src/ (${stale.newest}).\n` +
    `           You are running old UI — run \`npm run build\` to rebuild.`
  );
}
