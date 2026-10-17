/**
 * Live run state — one small file the TUI keeps fresh while it works, so
 * another terminal can answer "is it stuck?" without attaching a debugger:
 *
 *   watch -n1 piharness ps
 *
 * The file is advisory: a stale pid means the previous run crashed, and that
 * is reported rather than hidden.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteJson } from "../fsutil.js";

export const LIVE_VERSION = 1;

export interface LiveState {
  version: number;
  pid: number;
  sessionId?: string;
  cwd: string;
  model: string;
  startedAt: string;
  updatedAt: string;
  phase: "idle" | "generating" | "tool";
  /** Tool name while `phase` is "tool". */
  tool?: string;
  turnStartedAt?: string;
  /** Milliseconds since the last stream delta or tool event. */
  idleMs: number;
  /** Decode speed of the current turn, if known. */
  rate?: number;
  /** Tokens streamed this turn (estimate). */
  streamedTokens: number;
  toolCalls: number;
  /** Provider-reported total tokens for the session. */
  tokens: number;
}

export function liveStatePath(agentDir: string): string {
  return join(agentDir, "live.json");
}

export function writeLiveState(agentDir: string, state: LiveState): void {
  try {
    mkdirSync(agentDir, { recursive: true });
    atomicWriteJson(liveStatePath(agentDir), state);
  } catch {
    // Telemetry must never break a session.
  }
}

export function clearLiveState(agentDir: string, pid?: number): void {
  const file = liveStatePath(agentDir);
  try {
    if (!existsSync(file)) return;
    if (pid !== undefined) {
      const state = JSON.parse(readFileSync(file, "utf8")) as LiveState;
      if (state.pid !== pid) return; // a newer run owns the file now
    }
    rmSync(file, { force: true });
  } catch {
    // ignore
  }
}

export function readLiveState(agentDir: string): { state: LiveState; ageMs: number; alive: boolean } | null {
  const file = liveStatePath(agentDir);
  if (!existsSync(file)) return null;
  try {
    const state = JSON.parse(readFileSync(file, "utf8")) as LiveState;
    if (state.version !== LIVE_VERSION) return null;
    let alive = false;
    try {
      process.kill(state.pid, 0);
      alive = true;
    } catch {
      alive = false;
    }
    return { state, ageMs: Date.now() - Date.parse(state.updatedAt), alive };
  } catch {
    return null;
  }
}

function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
}

/** One line an operator can read at a glance, refreshed by `watch`. */
export function describeLive(live: NonNullable<ReturnType<typeof readLiveState>>): string {
  const { state, ageMs, alive } = live;
  const head = alive ? `pid ${state.pid}` : `pid ${state.pid} (dead)`;
  const uptime = duration(Date.now() - Date.parse(state.startedAt));
  const activity =
    state.phase === "tool"
      ? `tool ${state.tool ?? "?"}`
      : state.phase === "generating"
        ? state.rate === undefined
          ? "waiting for first token"
          : "generating"
        : "idle";
  const parts = [head, `up ${uptime}`, state.model, activity];
  if (state.rate !== undefined && state.phase !== "idle") parts.push(`${state.rate.toFixed(1)} t/s`);
  if (state.phase !== "idle" && state.streamedTokens > 0) parts.push(`+${Math.round(state.streamedTokens)} tok`);
  if (state.phase !== "idle" && state.idleMs >= 4000) parts.push(`no events ${Math.round(state.idleMs / 1000)}s`);
  parts.push(`${state.toolCalls} tools`, `${state.tokens} tokens`, state.cwd);

  const lines = [parts.join(" · ")];
  if (!alive) lines.push("state file is stale (process exited); run `piharness ps --clear` to remove it");
  else if (ageMs > 5000) lines.push(`warning: state file is ${duration(ageMs)} old — the UI thread is blocked`);
  else if (state.phase === "generating" && state.idleMs > 20000) {
    lines.push(`stalled: no output for ${duration(state.idleMs)} — check llama-server (/health, /slots)`);
  }
  return lines.join("\n");
}
