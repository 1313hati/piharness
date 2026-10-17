/**
 * Server-side liveness.
 *
 * Pi only emits a delta once the provider hands one over. Between "prompt
 * sent" and "first token", a 20k-token prefill can take half a minute, and
 * nothing is rendered — which reads as a hang. llama-server already knows the
 * truth: how many prompt tokens it has processed and how many it has decoded.
 * Sampling /slots gives the footer a counter that moves even when the harness
 * has nothing to draw.
 */

export interface ServerProgress {
  /** Prompt tokens processed so far, and the total for this slot. */
  prefill: number;
  prefillTotal: number;
  /** Tokens decoded in the current task. */
  decoded: number;
  /** False when the server is between tasks, or could not be reached. */
  running: boolean;
}

export const DEFAULT_SERVER_URL = "http://127.0.0.1:8080";

export function serverUrl(): string {
  return process.env.PIHARNESS_SERVER_URL ?? DEFAULT_SERVER_URL;
}

/** Parse llama-server's /slots payload (array or single object). */
export function parseSlots(payload: unknown): ServerProgress | null {
  const slots = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const busy = slots.filter((s: any) => s && s.is_processing);
  if (busy.length === 0) return null;
  const slot: any = busy[0];
  const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  return {
    prefill: num(slot.n_prompt_tokens_processed),
    prefillTotal: num(slot.n_prompt_tokens),
    decoded: num(slot.n_decoded),
    running: true,
  };
}

/**
 * Compact footer text. Deliberately not "1k/4k": llama-server keeps the last
 * task's totals on a slot, so a stale total is worse than no total. The count
 * that only ever grows during the current task is the useful one.
 */
export function formatProgress(p: ServerProgress): string {
  if (p.decoded > 0) return `${p.decoded} tok`;
  // Sub-500 tokens would render as "prefill 0k", which reads as a stall.
  if (p.prefill >= 500) return `prefill ${Math.round(p.prefill / 1000)}k`;
  return "";
}

/** Best-effort sample; never throws, never blocks the render loop. */
export async function sampleServer(timeoutMs = 400): Promise<ServerProgress | null> {
  try {
    const res = await fetch(`${serverUrl()}/slots`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    return parseSlots(await res.json());
  } catch {
    return null;
  }
}
